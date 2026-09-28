import { canonical, digest } from "./canonical.ts";
import {
	type Contract,
	inventoryFixture,
	inventoryReport,
	RECORD_BASELINE,
	recordFixture,
	recordsFilter,
	recordsFilterProgram,
} from "./contracts.ts";
import { bootstrapLowerBound, pairedGains } from "./evaluator.ts";
import type { Governor } from "./governor.ts";
import type { LibrarySkill, Program, Value } from "./ir.ts";
import { type ExecutionLimits, INSTALLATION_LIMITS } from "./limits.ts";
import { enumerateMutations, MUTATION_OPS } from "./mutate.ts";
import { mean, PyRandom } from "./random.ts";
import { clampPolicy, DEFAULT_POLICY, type SearchPolicy, searchImprovement } from "./search.ts";
import { type LatticeStore, newId } from "./store.ts";
import { checkProgram } from "./typecheck.ts";

/**
 * Level 2: improving the policy that searches for task programs (spec section 41). A fixed
 * controller schedules the experiments, enforces identical budgets and evaluates both levels.
 * There is no level 3.
 *
 * Score: for each task and seed, run the search with a fixed evaluator-call budget and record
 * the best valid development cost after every call, normalized by the parent's cost. The run's
 * score is 1 minus the mean of that curve (area above the best-valid-solution curve), so a
 * search that never finds anything better scores 0. Failed and invalid candidates count as
 * calls. CPU time is reported separately so a cheaper-but-worse search is visible.
 */
export const META_CONTRACT = { id: "search.policy", revision: 1 };
export const POLICY_SKILL = "search.policy";

export interface MetaTask {
	id: string;
	contract: Contract;
	parent: Program;
	costCases: Value[];
	checkCases: Value[];
}

/** Random search: every operator equally likely, half the beam from the archive, no test ordering. */
export const RANDOM_POLICY: SearchPolicy = {
	...DEFAULT_POLICY,
	mutation_weights: Object.fromEntries(MUTATION_OPS.map((op) => [op, 0.5])),
	archive_mix: 0.5,
	development_test_order: "fixed",
};

function shuffled<T>(items: readonly T[], rng: PyRandom): T[] {
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = rng.below(i + 1);
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/**
 * Task families. `selection` is visible to the policy search; release family `n` uses disjoint
 * seeds and is consumed once. Each task is an independent parent program with its own data:
 * inventory parents are the seed moved to a random point by a few sound rewrites, records parents
 * are random predicate orders.
 */
export function metaTasks(family: "selection" | { release: number }, size = 4): MetaTask[] {
	const base = family === "selection" ? 1_000 : 50_000 + family.release * 1_000;
	const rng = new PyRandom(base);
	const tasks: MetaTask[] = [];
	for (let t = 0; t < size; t++) {
		if (t % 3 === 2) {
			const order = shuffled(RECORD_BASELINE, rng);
			tasks.push({
				id: `records:${base + t}:${order.join(",")}`,
				contract: recordsFilter,
				parent: recordsFilterProgram(order),
				costCases: Array.from({ length: 3 }, (_, i) => recordFixture(base + t * 10 + i, 96) as unknown as Value),
				checkCases: recordsFilter.fixtures.regression(),
			});
			continue;
		}
		let parent = inventoryReport.seed();
		for (let step = 0; step < 3; step++) {
			const check = checkProgram(parent, {
				limits: INSTALLATION_LIMITS,
				granted: new Set(),
				library: new Map(),
				inputSummary: inventoryReport.inputBounds,
			});
			if (!check.ok) break;
			const moves = enumerateMutations(
				parent,
				check.info,
				new Set(["reorder_exclusive", "swap_independent"] as const),
			);
			if (moves.length === 0) break;
			parent = moves[rng.below(moves.length)].program;
		}
		tasks.push({
			id: `inventory:${base + t}`,
			contract: inventoryReport,
			parent,
			costCases: Array.from(
				{ length: 2 },
				(_, i) =>
					inventoryFixture(base + t * 10 + i, rng.random() < 0.5 ? "source" : "media", 80) as unknown as Value,
			),
			checkCases: inventoryReport.fixtures.regression(),
		});
	}
	return tasks;
}

export interface PolicyScore {
	score: number;
	/** One score per (task, seed) run, in a fixed order, for paired comparison. */
	runs: number[];
	/** Mean normalized best cost at the end of the budget (lower is better). */
	finalCost: number;
	noSolution: number;
	cpuMs: number;
}

export function scorePolicy(
	policy: SearchPolicy,
	tasks: readonly MetaTask[],
	options: {
		budget: number;
		seeds: readonly number[];
		limits: ExecutionLimits;
		library: ReadonlyMap<string, LibrarySkill>;
		/** `performance.now()` bound; exceeding it aborts the whole score, never truncates one run. */
		deadline?: number;
	},
): PolicyScore {
	// Identical budgets: the controller's budget replaces whatever the policy requests.
	const controlled = clampPolicy({ ...policy, max_evaluations: options.budget, patience: 8, max_depth: 8 });
	const runs: number[] = [];
	const finals: number[] = [];
	let noSolution = 0;
	const cpuStart = process.cpuUsage();
	for (const task of tasks) {
		for (const seed of options.seeds) {
			if (options.deadline !== undefined && performance.now() > options.deadline) {
				throw new Error("research budget exhausted before every policy was scored");
			}
			const report = searchImprovement({
				contract: task.contract,
				parent: task.parent,
				costCases: task.costCases,
				checkCases: task.checkCases,
				policy: controlled,
				limits: options.limits,
				library: options.library,
				seed,
				deadline: options.deadline,
			});
			if (report.stopReason === "deadline") throw new Error("research budget exhausted during a scored run");
			// Area under the normalized best-cost step function over the work budget (case runs).
			let area = 0;
			let previousWork = 0;
			let previousBest = 1;
			for (const point of report.curve) {
				const work = Math.min(point.work, report.budgetWork);
				area += previousBest * (work - previousWork);
				previousWork = work;
				previousBest = Math.min(1, point.best / report.parentCost);
			}
			area += previousBest * (report.budgetWork - previousWork);
			runs.push(1 - area / report.budgetWork);
			finals.push(Math.min(1, report.bestCost / report.parentCost));
			if (report.bestCost >= report.parentCost) noSolution++;
		}
	}
	const usage = process.cpuUsage(cpuStart);
	return {
		score: mean(runs),
		runs,
		finalCost: mean(finals),
		noSolution,
		cpuMs: (usage.user + usage.system) / 1000,
	};
}

/**
 * Level-2 proposals. First the coordinate neighborhood of the active policy (switch each enabled
 * operator off, halve or double the screening width, widen or narrow the beam, toggle test
 * ordering), in seeded random order; then random one- or two-edit proposals to fill `count`.
 */
export function proposePolicies(parent: SearchPolicy, rng: PyRandom, count: number): SearchPolicy[] {
	const proposals: SearchPolicy[] = [];
	const seen = new Set([canonical(clampPolicy(parent))]);
	const accept = (policy: SearchPolicy) => {
		const clamped = clampPolicy({ ...policy, policy_revision: parent.policy_revision + 1 });
		if (MUTATION_OPS.every((op) => (clamped.mutation_weights[op] ?? 0) === 0)) return;
		const key = canonical({ ...clamped, policy_revision: parent.policy_revision });
		if (seen.has(key) || proposals.length >= count) return;
		seen.add(key);
		proposals.push(clamped);
	};
	const neighborhood: SearchPolicy[] = [];
	for (const op of MUTATION_OPS) {
		if ((parent.mutation_weights[op] ?? 0) > 0) {
			neighborhood.push({ ...parent, mutation_weights: { ...parent.mutation_weights, [op]: 0 } });
		}
	}
	neighborhood.push(
		{ ...parent, screen_width: Math.round(parent.screen_width / 2) },
		{ ...parent, screen_width: parent.screen_width * 2 },
		{ ...parent, beam_width: parent.beam_width - 4 },
		{ ...parent, beam_width: parent.beam_width + 4 },
		{ ...parent, development_test_order: parent.development_test_order === "fixed" ? "rejection_per_cost" : "fixed" },
	);
	for (let i = neighborhood.length - 1; i > 0; i--) {
		const j = rng.below(i + 1);
		[neighborhood[i], neighborhood[j]] = [neighborhood[j], neighborhood[i]];
	}
	for (const policy of neighborhood) accept(policy);
	for (let attempt = 0; proposals.length < count && attempt < count * 20; attempt++) {
		const next: SearchPolicy = { ...parent, mutation_weights: { ...parent.mutation_weights } };
		const edits = 1 + rng.below(2);
		for (let edit = 0; edit < edits; edit++) {
			const op = MUTATION_OPS[rng.below(MUTATION_OPS.length)];
			const weight = next.mutation_weights[op] ?? 0;
			switch (rng.below(6)) {
				case 0:
					// Switch an operator off, or back on.
					next.mutation_weights[op] = weight > 0 ? 0 : 0.1;
					break;
				case 1:
					next.mutation_weights[op] = rng.random() < 0.5 ? Math.min(1, Math.max(0.05, weight * 2)) : weight / 2;
					break;
				case 2:
					next.beam_width = next.beam_width + (rng.random() < 0.5 ? -4 : 4);
					break;
				case 3:
					next.screen_width = Math.round(next.screen_width * (rng.random() < 0.5 ? 0.5 : 2));
					break;
				case 4:
					next.archive_mix = next.archive_mix + (rng.random() < 0.5 ? -0.1 : 0.1);
					break;
				default:
					next.development_test_order = next.development_test_order === "fixed" ? "rejection_per_cost" : "fixed";
			}
		}
		accept(next);
	}
	return proposals;
}

/** A proposal must beat its parent by this much on the selection family before it may consume a release set. */
export const MIN_SELECTION_GAIN = 0.002;

export interface PolicyCampaignReport {
	campaign_id: string;
	status: "promoted" | "rejected" | "no_candidate";
	parent_version: number;
	selection: {
		parent: number;
		random: number;
		best: number;
		proposals: { score: number; final: number; cpuMs: number }[];
	};
	release?: {
		release_set_id: string;
		parent: PolicyScore;
		candidate: PolicyScore;
		random: PolicyScore;
		mean_gain: number;
		lower_bound: number;
		reasons: string[];
	};
	promoted_version?: number;
	cpu_ms: number;
}

export function policyEvaluatorHash(): string {
	return digest({ score: scorePolicy.toString(), tasks: metaTasks.toString() });
}

export async function improvePolicy(
	kernel: { store: LatticeStore; governor: Governor; limits: ExecutionLimits; library(): Map<string, LibrarySkill> },
	options: { proposals?: number; budget?: number; seeds?: number[]; tasks?: number; seed?: number } = {},
): Promise<PolicyCampaignReport> {
	const { store, governor } = kernel;
	const head = store.headRecord<SearchPolicy>(POLICY_SKILL);
	if (!head) throw new Error("no active search policy; run init");
	const parent = head.record;
	const budget = options.budget ?? 48;
	const seeds = options.seeds ?? [1, 2, 3];
	const library = kernel.library();
	const campaignId = newId("camp");
	const allocation = governor.allocate("research");
	const cpuStart = process.cpuUsage();
	const cpuMs = () => {
		const usage = process.cpuUsage(cpuStart);
		return (usage.user + usage.system) / 1000;
	};
	store.startCampaign({
		campaignId,
		skillId: POLICY_SKILL,
		kind: "policy",
		parentVersion: head.version.version_id,
		record: { budget, seeds },
	});
	try {
		const selection = metaTasks("selection", options.tasks ?? 4);
		// The main thread is CPU-bound here, so wall time bounds CPU time: stop at the smaller budget.
		const deadline = performance.now() + Math.min(allocation.budget.wallMs, allocation.budget.cpuMs);
		const scoring = { budget, seeds, limits: kernel.limits, library, deadline };
		const parentScore = scorePolicy(parent, selection, scoring);
		const randomScore = scorePolicy(RANDOM_POLICY, selection, scoring);
		const rng = new PyRandom(options.seed ?? 4242);
		const proposals = proposePolicies(parent, rng, options.proposals ?? 12).map((policy) => ({
			policy,
			score: scorePolicy(policy, selection, scoring),
		}));
		const best = proposals.reduce<(typeof proposals)[number] | undefined>(
			(winner, entry) => (!winner || entry.score.score > winner.score.score ? entry : winner),
			undefined,
		);
		const report: PolicyCampaignReport = {
			campaign_id: campaignId,
			status: "no_candidate",
			parent_version: head.version.version_id,
			selection: {
				parent: parentScore.score,
				random: randomScore.score,
				best: best?.score.score ?? parentScore.score,
				proposals: proposals.map((entry) => ({
					score: entry.score.score,
					final: entry.score.finalCost,
					cpuMs: entry.score.cpuMs,
				})),
			},
			cpu_ms: 0,
		};
		if (!best || best.score.score < parentScore.score + MIN_SELECTION_GAIN) {
			report.cpu_ms = cpuMs();
			store.finishCampaign(campaignId, "no_candidate", report);
			return report;
		}
		// Freeze one policy and consume one fresh family of tasks.
		const releaseIndex = store.releaseSetsUsed(`${POLICY_SKILL}/r1/release/`) + 1;
		const releaseSetId = `${POLICY_SKILL}/r1/release/${String(releaseIndex).padStart(3, "0")}`;
		store.putPolicyRecord(best.policy);
		store.reserveRelease(releaseSetId, campaignId, digest(best.policy));
		const fresh = metaTasks({ release: releaseIndex }, options.tasks ?? 4);
		const releaseScoring = { ...scoring, seeds: seeds.map((s) => s + 1_000 * releaseIndex) };
		const parentRelease = scorePolicy(parent, fresh, releaseScoring);
		const candidateRelease = scorePolicy(best.policy, fresh, releaseScoring);
		const randomRelease = scorePolicy(RANDOM_POLICY, fresh, releaseScoring);
		// Paired over (task, seed) runs: gain is the score difference relative to the parent's room left.
		const gains = pairedGains(
			parentRelease.runs.map((score) => 1 - score),
			candidateRelease.runs.map((score) => 1 - score),
		);
		const bound = bootstrapLowerBound(gains, { resamples: 2000, seed: 8128, alpha: 0.05 });
		const reasons: string[] = [];
		if (!(bound.lower > 0)) reasons.push(`lower bound ${bound.lower.toFixed(4)} <= 0`);
		if (candidateRelease.finalCost > parentRelease.finalCost)
			reasons.push("final solution quality is worse than the parent's");
		if (candidateRelease.noSolution > parentRelease.noSolution)
			reasons.push("fails to improve more tasks than the parent");
		report.release = {
			release_set_id: releaseSetId,
			parent: parentRelease,
			candidate: candidateRelease,
			random: randomRelease,
			mean_gain: bound.mean,
			lower_bound: bound.lower,
			reasons,
		};
		store.finalizeRelease(releaseSetId, reasons.length === 0 ? "pass" : "fail", report.release);
		if (reasons.length === 0) {
			report.promoted_version = store.promote({
				skillId: POLICY_SKILL,
				expectedParent: head.version.version_id,
				program: best.policy,
				kind: "policy",
				campaignId,
				report: { selection: report.selection, release: report.release },
			});
			report.status = "promoted";
		} else report.status = "rejected";
		report.cpu_ms = cpuMs();
		store.finishCampaign(campaignId, report.status, report);
		return report;
	} catch (error) {
		store.finishCampaign(campaignId, "aborted", { error: error instanceof Error ? error.message : String(error) });
		throw error;
	} finally {
		governor.release(allocation);
	}
}
