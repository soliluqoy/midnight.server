import { canonical } from "./canonical.ts";
import type { Contract } from "./contracts.ts";
import { type EvalContext, evaluateCase } from "./evaluator.ts";
import { type Expr, type LibrarySkill, type Program, programHash, type Value } from "./ir.ts";
import { type ExecutionLimits, SEARCH_DEFAULTS } from "./limits.ts";
import {
	EVIDENCE_ONLY,
	enumerateMutations,
	MUTATION_OPS,
	type Mutation,
	type MutationOp,
	operatorFamily,
} from "./mutate.ts";
import { PRIMITIVE_LIBRARY_HASH } from "./primitives.ts";
import { PyRandom } from "./random.ts";
import { checkProgram, type NodeInfo } from "./typecheck.ts";

/**
 * The editable search policy (spec section 41.1). It is data: the level-2 loop may propose a new
 * revision, but budget fields are requests the fixed governor clamps.
 */
export interface SearchPolicy {
	policy_revision: number;
	strategy: "hill" | "beam";
	mutation_weights: { [op in MutationOp]?: number };
	beam_width: number;
	max_depth: number;
	archive_mix: number;
	development_test_order: "fixed" | "rejection_per_cost";
	/** Budget in full-evaluation equivalents, counted in weighted case runs (screening included). */
	max_evaluations: number;
	/** Successors screened per beam depth, drawn in weighted random order. */
	screen_width: number;
	/** Stop after this many depths without a development improvement. */
	patience: number;
}

export const DEFAULT_POLICY: SearchPolicy = {
	policy_revision: 1,
	strategy: "beam",
	mutation_weights: {
		swap_independent: 0.3,
		reorder_exclusive: 0.2,
		hoist_common: 0.15,
		fuse_filters: 0.05,
		split_filter: 0.05,
		dedupe_conjunct: 0.1,
		drop_conjunct: 0.15,
	},
	beam_width: 16,
	max_depth: 8,
	archive_mix: 0.2,
	development_test_order: "rejection_per_cost",
	max_evaluations: 256,
	screen_width: 128,
	patience: 2,
};

/** The reference's search: first-improvement hill climbing over adjacent swaps, capped at 80 evaluations. */
export const REFERENCE_POLICY: SearchPolicy = {
	...DEFAULT_POLICY,
	strategy: "hill",
	mutation_weights: { swap_independent: 1 },
	development_test_order: "fixed",
	max_evaluations: 80,
};

export function clampPolicy(policy: SearchPolicy): SearchPolicy {
	const clamp = (value: number, lo: number, hi: number) =>
		Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : lo;
	const weights: SearchPolicy["mutation_weights"] = {};
	for (const op of MUTATION_OPS) {
		const weight = policy.mutation_weights[op];
		if (weight !== undefined) weights[op] = clamp(weight, 0, 1);
	}
	return {
		...policy,
		mutation_weights: weights,
		beam_width: Math.round(clamp(policy.beam_width, 1, SEARCH_DEFAULTS.beamWidth)),
		max_depth: Math.round(clamp(policy.max_depth, 1, SEARCH_DEFAULTS.maxSearchDepth)),
		archive_mix: clamp(policy.archive_mix, 0, 0.5),
		max_evaluations: Math.round(clamp(policy.max_evaluations, 1, SEARCH_DEFAULTS.maxCandidatesPerCampaign)),
		screen_width: Math.round(clamp(policy.screen_width ?? DEFAULT_POLICY.screen_width, 1, 256)),
		patience: Math.round(clamp(policy.patience, 1, 8)),
	};
}

export interface SearchInput {
	contract: Contract;
	parent: Program;
	/** Development cases: correctness required, cost summed. */
	costCases: readonly Value[];
	/** Regression cases: correctness required, cost ignored. */
	checkCases: readonly Value[];
	policy: SearchPolicy;
	limits: ExecutionLimits;
	library: ReadonlyMap<string, LibrarySkill>;
	seed: number;
	signal?: AbortSignal;
	/** `performance.now()` deadline. */
	deadline?: number;
	/** Extra verification for evidence-only proposals: returns a failing input or undefined. */
	verifier?: (candidate: Program) => { input: Value; failure: string } | undefined;
}

export interface Counterexample {
	input: Value;
	failure: string;
	candidateHash: string;
}

export interface SearchReport {
	best: Program;
	bestHash: string;
	parentCost: number;
	bestCost: number;
	lineage: string[];
	/** Full development evaluations. */
	evaluations: number;
	/** Screening runs on a small subset. */
	screened: number;
	/** Evaluator work: 1 + input items per case run, screening and full alike, failures included. */
	work: number;
	/** The work budget: max_evaluations full evaluations' worth of case runs. */
	budgetWork: number;
	generated: number;
	duplicates: number;
	rejectedStatic: number;
	rejectedDevelopment: number;
	counterexamples: Counterexample[];
	/** Best feasible development cost after each evaluation, with the work spent so far (level-2 curve). */
	curve: { work: number; best: number }[];
	archive: { hash: string; cost: number; family: string }[];
	stopReason: string;
}

interface Scored {
	program: Program;
	hash: string;
	cost: number;
	lineage: string[];
	info: ReadonlyMap<Expr, NodeInfo>;
}

export function searchImprovement(input: SearchInput): SearchReport {
	const policy = clampPolicy(input.policy);
	const rng = new PyRandom(input.seed);
	const context: EvalContext = {
		limits: input.limits,
		library: input.library,
		signal: input.signal,
		deadline: input.deadline,
	};
	const options = {
		limits: input.limits,
		granted: new Set(input.contract.granted),
		library: input.library,
		inputSummary: input.contract.inputBounds,
	};
	const allowed = new Set(MUTATION_OPS.filter((op) => (policy.mutation_weights[op] ?? 0) > 0));
	// Per-case rejection statistics for test ordering (development history only, section 40.5).
	const cases = [
		...input.checkCases.map((value) => ({ value, counted: false })),
		...input.costCases.map((value) => ({ value, counted: true })),
	].map((entry, index) => ({
		...entry,
		index,
		runs: 0,
		rejections: 0,
		units: 0,
		// Evaluator work for one run of this case, independent of the program: 1 + input items.
		weight: 1 + (Array.isArray(entry.value) ? entry.value.length : 0),
	}));

	const report: SearchReport = {
		best: input.parent,
		bestHash: programHash(input.parent, PRIMITIVE_LIBRARY_HASH),
		parentCost: Number.POSITIVE_INFINITY,
		bestCost: Number.POSITIVE_INFINITY,
		lineage: [],
		evaluations: 0,
		screened: 0,
		work: 0,
		budgetWork: policy.max_evaluations * cases.reduce((total, entry) => total + entry.weight, 0),
		generated: 0,
		duplicates: 0,
		rejectedStatic: 0,
		rejectedDevelopment: 0,
		counterexamples: [],
		curve: [],
		archive: [],
		stopReason: "exhausted",
	};

	/**
	 * Development evaluation over `subset` (default: every case). Every case must be correct;
	 * returns the summed cost of the counted cases, or undefined.
	 */
	const evaluate = (program: Program, hash: string, subset: typeof cases = cases): number | undefined => {
		if (subset === cases) report.evaluations++;
		else report.screened++;
		const order =
			policy.development_test_order === "rejection_per_cost"
				? [...subset].sort(
						(a, b) =>
							(b.rejections + 1) / (b.runs + 2) / (b.units / Math.max(b.runs, 1) + 1) -
								(a.rejections + 1) / (a.runs + 2) / (a.units / Math.max(a.runs, 1) + 1) || a.index - b.index,
					)
				: subset;
		let cost = 0;
		for (const entry of order) {
			const result = evaluateCase(input.contract, program, entry.value, context);
			report.work += entry.weight;
			entry.runs++;
			entry.units += result.units ?? 0;
			if (!result.correct) {
				entry.rejections++;
				report.rejectedDevelopment++;
				if (report.counterexamples.length < SEARCH_DEFAULTS.maxCounterexamplesPerCampaign) {
					report.counterexamples.push({
						input: entry.value,
						failure: result.failure ?? "incorrect",
						candidateHash: hash,
					});
				}
				report.curve.push({ work: report.work, best: report.bestCost });
				return undefined;
			}
			if (entry.counted) cost += result.units ?? 0;
		}
		report.curve.push({
			work: report.work,
			best: subset === cases ? Math.min(report.bestCost, cost) : report.bestCost,
		});
		return cost;
	};

	const parentCheck = checkProgram(input.parent, options);
	if (!parentCheck.ok) throw new Error(`parent rejected: ${parentCheck.error}`);
	const parentCost = evaluate(input.parent, report.bestHash);
	if (parentCost === undefined) throw new Error("the active parent fails its own development cases");
	report.parentCost = parentCost;
	report.bestCost = parentCost;
	report.curve[report.curve.length - 1] = { work: report.work, best: parentCost };

	const seen = new Set<string>([report.bestHash]);
	const archive = new Map<string, { scored: Scored; family: string }>();
	const outOfBudget = () => {
		if (report.work >= report.budgetWork) return "evaluation budget exhausted";
		if (report.generated >= SEARCH_DEFAULTS.maxCandidatesPerCampaign * 4) return "candidate budget exhausted";
		if (input.signal?.aborted) return "cancelled";
		if (input.deadline !== undefined && performance.now() > input.deadline) return "deadline";
		return undefined;
	};

	/** Deduplicate by canonical hash and admit statically. */
	const admit = (mutation: Mutation): { hash: string; info: ReadonlyMap<Expr, NodeInfo> } | undefined => {
		report.generated++;
		const hash = programHash(mutation.program, PRIMITIVE_LIBRARY_HASH);
		if (seen.has(hash)) {
			report.duplicates++;
			return undefined;
		}
		seen.add(hash);
		const check = checkProgram(mutation.program, options);
		if (!check.ok) {
			report.rejectedStatic++;
			return undefined;
		}
		return { hash, info: check.info };
	};

	/** Full development evaluation, verification of evidence-only proposals, archive and best tracking. */
	const score = (
		mutation: Mutation,
		from: Scored,
		admitted: { hash: string; info: ReadonlyMap<Expr, NodeInfo> },
	): Scored | undefined => {
		const { hash } = admitted;
		const cost = evaluate(mutation.program, hash);
		if (cost === undefined) return undefined;
		if (EVIDENCE_ONLY.has(mutation.op) && input.verifier) {
			const failure = input.verifier(mutation.program);
			if (failure) {
				report.rejectedDevelopment++;
				report.counterexamples.push({ ...failure, candidateHash: hash });
				return undefined;
			}
		}
		const scored: Scored = {
			program: mutation.program,
			hash,
			cost,
			lineage: [...from.lineage, mutation.description],
			info: admitted.info,
		};
		const family = operatorFamily(mutation.program);
		const inFamily = [...archive.values()].filter((entry) => entry.family === family);
		if (archive.size < SEARCH_DEFAULTS.maxArchiveEntries && inFamily.length < SEARCH_DEFAULTS.maxArchivePerFamily) {
			archive.set(hash, { scored, family });
		}
		if (cost < report.bestCost) {
			report.best = mutation.program;
			report.bestHash = hash;
			report.bestCost = cost;
			report.lineage = scored.lineage;
		}
		return scored;
	};

	const consider = (mutation: Mutation, from: Scored): Scored | undefined => {
		const admitted = admit(mutation);
		return admitted ? score(mutation, from, admitted) : undefined;
	};

	// Screening subset for the beam: the regression cases plus the parent's cheapest development case.
	const screenCase = cases
		.filter((entry) => entry.counted)
		.reduce<(typeof cases)[number] | undefined>(
			(cheapest, entry) => (!cheapest || entry.units < cheapest.units ? entry : cheapest),
			undefined,
		);
	const screening = cases.filter((entry) => !entry.counted || entry === screenCase);

	const root: Scored = {
		program: input.parent,
		hash: report.bestHash,
		cost: parentCost,
		lineage: [],
		info: parentCheck.info,
	};

	if (policy.strategy === "hill") {
		let champion = root;
		for (;;) {
			const stop = outOfBudget();
			if (stop) {
				report.stopReason = stop;
				break;
			}
			const neighbors = enumerateMutations(champion.program, champion.info, allowed).filter(
				(mutation) => !seen.has(programHash(mutation.program, PRIMITIVE_LIBRARY_HASH)),
			);
			if (neighbors.length === 0) {
				report.stopReason = "no unseen neighbors";
				break;
			}
			let best = champion;
			for (const mutation of neighbors) {
				if (outOfBudget()) break;
				const scored = consider(mutation, champion);
				if (scored && scored.cost < best.cost) best = scored;
			}
			if (best.cost >= champion.cost) {
				report.stopReason = "local optimum";
				break;
			}
			champion = best;
		}
	} else {
		let beam: Scored[] = [root];
		let stale = 0;
		for (let depth = 0; depth < policy.max_depth; depth++) {
			const before = report.bestCost;
			const successors: { mutation: Mutation; from: Scored; key: number }[] = [];
			for (const member of beam) {
				for (const mutation of enumerateMutations(member.program, member.info, allowed)) {
					// Weighted random order: an exponential race keyed by the operator weight.
					const weight = policy.mutation_weights[mutation.op] ?? 0;
					successors.push({ mutation, from: member, key: -Math.log(1 - rng.random()) / weight });
				}
			}
			successors.sort((a, b) => a.key - b.key);
			// Cheap screening first (section 40.4): a correct run on the screening subset, ranked by
			// its cost there; only the best `beam_width` receive a full development evaluation.
			let screenedThisDepth = 0;
			const screened: {
				mutation: Mutation;
				from: Scored;
				admitted: { hash: string; info: ReadonlyMap<Expr, NodeInfo> };
				cost: number;
			}[] = [];
			for (const { mutation, from } of successors) {
				const stop = outOfBudget();
				if (stop) {
					report.stopReason = stop;
					break;
				}
				if (screenedThisDepth >= policy.screen_width) break;
				const admitted = admit(mutation);
				if (!admitted) continue;
				screenedThisDepth++;
				const cost = evaluate(mutation.program, admitted.hash, screening);
				if (cost !== undefined) screened.push({ mutation, from, admitted, cost });
			}
			screened.sort((a, b) => a.cost - b.cost || a.admitted.hash.localeCompare(b.admitted.hash));
			const next: Scored[] = [];
			for (const entry of screened.slice(0, policy.beam_width)) {
				const stop = outOfBudget();
				if (stop) {
					report.stopReason = stop;
					break;
				}
				const scored = score(entry.mutation, entry.from, entry.admitted);
				if (scored) next.push(scored);
			}
			if (next.length === 0 && report.stopReason === "exhausted") {
				report.stopReason = "no feasible successors";
			}
			// Keep the cheapest, but reserve slots for distinct families and archive explorers.
			next.sort((a, b) => a.cost - b.cost || a.hash.localeCompare(b.hash));
			const explorers = Math.floor(policy.beam_width * policy.archive_mix);
			const kept: Scored[] = [];
			const families = new Set<string>();
			for (const candidate of next) {
				if (kept.length >= policy.beam_width - explorers) break;
				const family = operatorFamily(candidate.program);
				if (families.has(family) && kept.length >= Math.ceil((policy.beam_width - explorers) / 2)) continue;
				families.add(family);
				kept.push(candidate);
			}
			const pool = [...archive.values()].map((entry) => entry.scored).filter((entry) => !kept.includes(entry));
			for (let i = 0; i < explorers && pool.length > 0; i++) kept.push(pool.splice(rng.below(pool.length), 1)[0]);
			beam = kept;
			if (report.stopReason !== "exhausted" && report.stopReason !== "no feasible successors") break;
			stale = report.bestCost < before ? 0 : stale + 1;
			if (stale >= policy.patience) {
				report.stopReason = "no development improvement";
				break;
			}
			if (beam.length === 0) break;
		}
	}
	report.archive = [...archive.values()]
		.map(({ scored, family }) => ({ hash: scored.hash, cost: scored.cost, family }))
		.sort((a, b) => a.cost - b.cost);
	return report;
}

/**
 * Counterexample search for evidence-only proposals (spec section 10.6): run the candidate on
 * perturbed inputs, and on failure shrink the failing list input to a small failing sublist,
 * so the stored regression case names the actual cause.
 */
export function makeVerifier(
	contract: Contract,
	context: EvalContext,
	generate: (rng: PyRandom) => Value,
	options: { seed: number; trials: number },
): (candidate: Program) => { input: Value; failure: string } | undefined {
	return (candidate) => {
		const rng = new PyRandom(options.seed);
		for (let trial = 0; trial < options.trials; trial++) {
			const value = generate(rng);
			const result = evaluateCase(contract, candidate, value, context);
			if (result.correct) continue;
			return { input: shrink(contract, candidate, value, context), failure: result.failure ?? "incorrect" };
		}
		return undefined;
	};
}

/** Delta debugging over list inputs, bounded to 64 re-runs. */
export function shrink(contract: Contract, program: Program, input: Value, context: EvalContext): Value {
	if (!Array.isArray(input)) return input;
	const fails = (value: Value[]) => !evaluateCase(contract, program, value, context).correct;
	let current = input.slice();
	let budget = 64;
	let chunk = Math.ceil(current.length / 2);
	while (chunk >= 1 && budget > 0) {
		let reduced = false;
		for (let start = 0; start < current.length && budget > 0; start += chunk) {
			const candidate = [...current.slice(0, start), ...current.slice(start + chunk)];
			budget--;
			if (candidate.length > 0 && fails(candidate)) {
				current = candidate;
				reduced = true;
				break;
			}
		}
		if (!reduced) chunk = Math.floor(chunk / 2);
	}
	return canonical(current) === canonical(input) ? input : current;
}
