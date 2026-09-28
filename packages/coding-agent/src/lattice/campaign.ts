import { canonical, digest } from "./canonical.ts";
import { COMPILER_VERSION } from "./compile.ts";
import { type Contract, evaluatorHash } from "./contracts.ts";
import {
	alphaForCampaign,
	bootstrapLowerBound,
	DEFAULT_GATE,
	type EvalContext,
	evaluateCase,
	evaluateSuite,
	execute,
	type GateEvidence,
	type GateThresholds,
	pairedGains,
	releaseGate,
} from "./evaluator.ts";
import { economicGate, type Governor } from "./governor.ts";
import { interpret } from "./interpreter.ts";
import { type LibrarySkill, programHash, type Value } from "./ir.ts";
import type { ExecutionLimits } from "./limits.ts";
import { PRIMITIVE_LIBRARY_HASH } from "./primitives.ts";
import { mean } from "./random.ts";
import { clampPolicy, type SearchCheckpoint, type SearchPolicy, type SearchReport } from "./search.ts";
import { KERNEL_VERSION, type LatticeStore, newId } from "./store.ts";
import { checkProgram } from "./typecheck.ts";
import { handleRequest, runIsolated, type WorkerRequest } from "./worker.ts";

/**
 * One improvement campaign (spec sections 12.2, 12.3, 29.3 and 38). Stages:
 * A diagnose, B-E propose and filter on development and regression cases, F freeze and consume
 * one fresh release set, G shadow on live snapshots, H promote through compare-and-swap or stop.
 * A failed or incomplete gate leaves the parent active; nothing is retried on the same release.
 */
export interface KernelContext {
	store: LatticeStore;
	governor: Governor;
	limits: ExecutionLimits;
	library(): Map<string, LibrarySkill>;
	/** Recent live inputs for this contract (newest first), used for development and shadow. */
	episodeInputs(contract: Contract, limit: number): Value[];
}

export interface CampaignOptions {
	skillId: string;
	contract: Contract;
	policy: SearchPolicy;
	policyHash: string;
	/** Run the development search in an isolated worker thread (default true). */
	isolate?: boolean;
	/** The user explicitly asked for this campaign; skip the economic gate. */
	explore?: boolean;
	seed?: number;
	gate?: GateThresholds;
	/** Minimum live snapshots for the shadow phase; 0 lets an operator waive it explicitly. */
	shadowMin?: number;
	verifierTrials?: number;
	/**
	 * Pauses the development search: the worker stops between candidates and returns a checkpoint,
	 * the campaign is stored as `paused`, and nothing is promoted.
	 */
	signal?: AbortSignal;
	/** Resume this paused campaign from its checkpoint (spec section 42.5). */
	resume?: string;
	/** Test hook: runs after the release set is reserved, before evaluation. */
	onReserved?: () => void;
}

export interface CampaignReport {
	campaign_id: string;
	skill_id: string;
	status: "promoted" | "rejected" | "incomplete" | "no_candidate" | "aborted" | "paused";
	parent_version: number;
	diagnosis: { parent_units: number; profile: { [op: string]: number }; economic?: unknown };
	development?: Omit<SearchReport, "best" | "curve" | "archive" | "counterexamples"> & {
		counterexamples_recorded: number;
		archive_size: number;
	};
	frozen_plan?: unknown;
	release?: unknown;
	gate?: { verdict: string; reasons: string[] };
	promoted_version?: number;
	reproducibility: {
		campaign_id: string;
		parent_version: number;
		proposal_seed: number;
		development_hash: string;
		heldout_hash?: string;
		policy_hash: string;
		kernel_hash: string;
		candidate_count: number;
		evaluation_count: number;
		accepted_version: number | null;
	};
	cpu_ms?: number;
	limits: string;
}

const LIVE_DEVELOPMENT_MAX_ITEMS = 1_000;

interface PausedCampaign {
	stage: "search";
	checkpoint: SearchCheckpoint;
	costCases: Value[];
	checkCases: Value[];
	seed: number;
	policy: SearchPolicy;
}

/** A paused campaign may resume only while its parent is still active. */
function loadPaused(store: LatticeStore, campaignId: string, skillId: string, activeVersion: number): PausedCampaign {
	const campaign = store.campaign(campaignId);
	if (!campaign || campaign.skill_id !== skillId) throw new Error(`no campaign ${campaignId} for ${skillId}`);
	if (campaign.status !== "paused") throw new Error(`campaign ${campaignId} is ${campaign.status}, not paused`);
	if (campaign.parent_version !== activeVersion) {
		store.finishCampaign(campaignId, "aborted", { reason: "parent changed while paused" });
		throw new Error("the active version changed while the campaign was paused; its checkpoint is stale");
	}
	const state = store.loadCheckpoint<PausedCampaign>(campaignId);
	if (!state || state.stage !== "search") throw new Error(`campaign ${campaignId} has no search checkpoint`);
	return state;
}

export function kernelHash(contract: Contract): string {
	return digest({
		kernel: KERNEL_VERSION,
		primitives: PRIMITIVE_LIBRARY_HASH,
		compiler: COMPILER_VERSION,
		evaluator: evaluatorHash(contract),
	});
}

export async function runCampaign(kernel: KernelContext, options: CampaignOptions): Promise<CampaignReport> {
	const { store, governor } = kernel;
	const { contract, skillId } = options;
	const head = store.head(skillId);
	if (!head) throw new Error(`no active version for ${skillId}`);
	if (!head.promotionEnabled) throw new Error(`promotion is disabled for ${skillId}; run a diagnostic test first`);
	if (store.paused) throw new Error(`promotion is stopped: ${store.paused}`);
	const library = kernel.library();
	const context: EvalContext = { limits: kernel.limits, library };
	// A resumed campaign continues with exactly the cases, seed and policy it paused with.
	const paused = options.resume ? loadPaused(store, options.resume, skillId, head.version.version_id) : undefined;
	const policy = paused ? paused.policy : clampPolicy(options.policy);
	const seed = paused ? paused.seed : (options.seed ?? 8128);
	const campaignId = paused ? options.resume! : newId("camp");

	// Development pool: contract fixtures plus earlier live snapshots (small ones only, so one huge
	// tree cannot dominate the budget). Regression pool: edge cases plus every stored counterexample.
	const live = paused
		? []
		: kernel
				.episodeInputs(contract, 16)
				.filter((input) => !Array.isArray(input) || input.length <= LIVE_DEVELOPMENT_MAX_ITEMS)
				.slice(0, 6);
	const costCases = paused ? paused.costCases : [...contract.fixtures.development(), ...live];
	const checkCases = paused
		? paused.checkCases
		: [...contract.fixtures.regression(), ...(store.regressions(contract) as Value[])];
	const developmentHash = digest({ costCases, checkCases });
	const record: CampaignReport["reproducibility"] = {
		campaign_id: campaignId,
		parent_version: head.version.version_id,
		proposal_seed: seed,
		development_hash: developmentHash,
		policy_hash: options.policyHash,
		kernel_hash: kernelHash(contract),
		candidate_count: 0,
		evaluation_count: 0,
		accepted_version: null,
	};
	const report: CampaignReport = {
		campaign_id: campaignId,
		skill_id: skillId,
		status: "no_candidate",
		parent_version: head.version.version_id,
		diagnosis: { parent_units: 0, profile: {} },
		reproducibility: record,
		limits: "virtual cost model; synthetic release families; worker threads bound memory and time, not privilege",
	};

	// Stage A: diagnose the parent where its cost goes.
	const profile = new Map<string, number>();
	let parentUnits = 0;
	for (const input of costCases) {
		const run = interpret(head.program, input, { limits: kernel.limits, library, profile });
		if (!run.ok) throw new Error(`the active version fails a development case (${run.error.code}); run a diagnostic`);
		parentUnits += run.metrics.units;
	}
	report.diagnosis = { parent_units: parentUnits, profile: Object.fromEntries(profile) };
	// Semantic memory (section 7.3): where the parent's cost goes, with provenance and an expiry.
	if (!paused)
		store.addFact({
			subject: skillId,
			predicate: "cost_profile",
			object: { version: head.version.version_id, units: parentUnits, by_primitive: report.diagnosis.profile },
			confidence: 1,
			provenance: campaignId,
			ttlMs: 30 * 24 * 3600 * 1000,
		});
	if (!options.explore && !paused) {
		const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
		const economic = economicGate({
			expectedFutureCalls: store.countEpisodes(contract.id, weekAgo) * 4,
			unitsPerCall: parentUnits / Math.max(costCases.length, 1),
			expectedReduction: 0.1,
			searchUnits: parentUnits * policy.max_evaluations,
		});
		report.diagnosis.economic = economic;
		if (!economic.worthIt) {
			store.audit("campaign_skipped", skillId, { reason: "economic gate", economic });
			return report;
		}
	}

	const allocation = governor.allocate("background");
	if (paused) store.setCampaignStatus(campaignId, "running", "resumed from checkpoint");
	else {
		store.startCampaign({
			campaignId,
			skillId,
			kind: "program",
			parentVersion: head.version.version_id,
			record,
		});
	}
	try {
		// Stages B-E: propose, statically reject, evaluate on development and regression cases.
		const request: WorkerRequest = {
			kind: "search",
			contractId: contract.id,
			parent: head.program,
			costCases,
			checkCases,
			policy,
			limits: kernel.limits,
			library: [...library.entries()],
			seed,
			// The search thread is single-threaded and CPU-bound, so its wall time bounds its CPU time:
			// stop at the smaller of the campaign's CPU and wall budgets (spec section 42.1).
			wallMs: Math.max(1, Math.min(allocation.deadline - performance.now(), allocation.budget.cpuMs)),
			verifierTrials: options.verifierTrials ?? 16,
			stopBuffer: options.signal && options.isolate !== false ? new SharedArrayBuffer(4) : undefined,
			resume: paused?.checkpoint,
		};
		const response =
			options.isolate === false ? handleRequest(request) : await runIsolated(request, undefined, options.signal);
		if (response.kind !== "search") throw new Error("unexpected worker response");
		const search = response.report;
		if (search.stopReason === "cancelled" && search.checkpoint) {
			// Paused for interactive work: keep the population and the exact cases, promote nothing.
			const state: PausedCampaign = {
				stage: "search",
				checkpoint: search.checkpoint,
				costCases,
				checkCases,
				seed,
				policy,
			};
			store.saveCheckpoint(campaignId, state);
			report.status = "paused";
			store.finishCampaign(campaignId, "paused", record);
			store.audit("campaign_paused", skillId, {
				campaign: campaignId,
				evaluations: search.evaluations,
				best_cost: search.bestCost,
			});
			return report;
		}
		record.candidate_count = search.generated;
		record.evaluation_count = search.evaluations;
		const known = new Set([...costCases, ...checkCases].map((value) => digest(value)));
		let recorded = 0;
		for (const counterexample of search.counterexamples) {
			if (known.has(digest(counterexample.input))) continue;
			let input: Value;
			try {
				input = contract.validateInput(counterexample.input);
			} catch {
				continue; // worker output is data; an input outside the contract is not a regression case
			}
			if (store.addRegression(contract, input, counterexample.failure, counterexample.candidateHash)) recorded++;
		}
		const summary = {
			bestHash: search.bestHash,
			parentCost: search.parentCost,
			bestCost: search.bestCost,
			lineage: search.lineage,
			evaluations: search.evaluations,
			screened: search.screened,
			work: search.work,
			budgetWork: search.budgetWork,
			generated: search.generated,
			duplicates: search.duplicates,
			rejectedStatic: search.rejectedStatic,
			rejectedDevelopment: search.rejectedDevelopment,
			stopReason: search.stopReason,
		};
		report.development = { ...summary, counterexamples_recorded: recorded, archive_size: search.archive.length };
		store.recordEvaluation(campaignId, search.bestHash, "development", summary, "searched");
		const parentHash = programHash(head.program, PRIMITIVE_LIBRARY_HASH);
		if (search.bestHash === parentHash || search.bestCost >= search.parentCost) {
			report.status = "no_candidate";
			store.finishCampaign(campaignId, "no_candidate", record);
			store.audit("campaign_finished", skillId, { campaign: campaignId, status: "no_candidate" });
			return report;
		}

		// Stage F: freeze. The kernel re-derives every fact itself; nothing from the worker is trusted,
		// and a candidate that fails re-verification is rejected before it can spend a release set.
		const candidate = search.best;
		const check = checkProgram(candidate, {
			limits: kernel.limits,
			granted: new Set(contract.granted),
			library,
			inputSummary: contract.inputBounds,
		});
		const regression = check.ok
			? evaluateSuite(contract, candidate, [...costCases, ...checkCases], context)
			: undefined;
		const kernelCost = regression?.allCorrect
			? regression.costs.slice(0, costCases.length).reduce((a, b) => a + b, 0)
			: undefined;
		if (!check.ok || !regression?.allCorrect || kernelCost === undefined || kernelCost >= parentUnits) {
			const reason = !check.ok
				? `candidate rejected statically: ${check.error}`
				: !regression?.allCorrect
					? "candidate failed kernel re-verification on development or regression cases"
					: "no development improvement when the kernel re-ran the candidate";
			report.status = "rejected";
			report.gate = { verdict: "fail", reasons: [reason] };
			store.finishCampaign(campaignId, "rejected", record);
			store.audit("campaign_finished", skillId, { campaign: campaignId, status: "rejected", reason });
			return report;
		}
		const candidateHash = programHash(candidate, PRIMITIVE_LIBRARY_HASH);
		const releaseIndex = store.releaseSetsUsed(`${skillId}/r${contract.revision}/release/`) + 1;
		const releaseSetId = `${skillId}/r${contract.revision}/release/${String(releaseIndex).padStart(3, "0")}`;
		const alpha = alphaForCampaign(releaseIndex);
		const gate = options.gate ?? DEFAULT_GATE;
		const frozenPlan = {
			candidate_hash: candidateHash,
			parent_version: head.version.version_id,
			contract: `${contract.id}@${contract.revision}`,
			development_hash: developmentHash,
			release_set_id: releaseSetId,
			release_batches: contract.fixtures.release(releaseIndex).length,
			shifted_batches: contract.fixtures.shifted(releaseIndex).length,
			thresholds: gate,
			alpha,
			bootstrap: { resamples: 2000, seed: 8128 },
			metric: "virtual units per batch, paired",
			stopping_rule: "fixed sample, single look",
			candidates_allowed_to_consume_release: 1,
		};
		report.frozen_plan = frozenPlan;
		store.saveCheckpoint(campaignId, { stage: "frozen", frozen_plan: frozenPlan, candidate });
		store.putProgram(candidate);
		store.reserveRelease(releaseSetId, campaignId, candidateHash);
		options.onReserved?.();

		// Release evaluation on cases the search never saw.
		const release = contract.fixtures.release(releaseIndex);
		const shifted = contract.fixtures.shifted(releaseIndex);
		record.heldout_hash = digest(release);
		const parentRelease = evaluateSuite(contract, head.program, release, context);
		const childRelease = evaluateSuite(contract, candidate, release, context);
		const parentShift = evaluateSuite(contract, head.program, shifted, context);
		const childShift = evaluateSuite(contract, candidate, shifted, context);
		const releaseCorrect = parentRelease.allCorrect && childRelease.allCorrect && childShift.allCorrect;
		let bound = { mean: Number.NaN, lower: Number.NaN };
		let absoluteGain = Number.NaN;
		if (releaseCorrect) {
			const gains = pairedGains(parentRelease.costs, childRelease.costs);
			bound = bootstrapLowerBound(gains, { resamples: 2000, seed: 8128, alpha });
			absoluteGain = mean(parentRelease.costs.map((p, i) => p - childRelease.costs[i]));
		}
		const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
		const shiftRatio = sum(childShift.costs) / Math.max(sum(parentShift.costs), 1);
		// Reproducibility: a fresh run of the frozen candidate gives identical outputs and costs.
		const reproducible = release.slice(0, 4).every((input, index) => {
			const first = execute(candidate, input, context);
			return (
				first.ok &&
				canonical(first.value) === canonical(contract.oracle(input)) &&
				first.metrics.units === childRelease.costs[index]
			);
		});
		const p95 = (values: number[]) =>
			[...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0;
		const resourcesWithinLimits = childRelease.allCorrect && p95(childRelease.costs) <= p95(parentRelease.costs);

		// Stage G: shadow on live read snapshots (outputs must agree with the parent and the oracle).
		const shadowInputs = kernel.episodeInputs(contract, 20);
		const shadowMin = options.shadowMin ?? 1;
		let shadowPassed: boolean | undefined;
		let shadowNote = "";
		if (shadowInputs.length >= Math.max(shadowMin, 1)) {
			shadowPassed = shadowInputs.every((input) => {
				const a = execute(head.program, input, context);
				const b = execute(candidate, input, context);
				return (
					a.ok &&
					b.ok &&
					canonical(a.value) === canonical(b.value) &&
					evaluateCase(contract, candidate, input, context).correct
				);
			});
			shadowNote = `${shadowInputs.length} live snapshots`;
		} else if (shadowMin === 0) {
			shadowPassed = true;
			shadowNote = "waived by operator: no live snapshots";
		} else shadowNote = `needs ${shadowMin} live snapshots, have ${shadowInputs.length}`;

		const evidence: Partial<GateEvidence> = {
			typecheckPassed: check.ok,
			permissionsValid:
				check.ok && check.effects.every((effect) => effect === "pure" || contract.granted.includes(effect)),
			regressionsPassed: regression.allCorrect,
			releaseCorrect,
			improvementLowerBound: releaseCorrect ? bound.lower : Number.NEGATIVE_INFINITY,
			absoluteGain: releaseCorrect ? absoluteGain : Number.NEGATIVE_INFINITY,
			worstProtectedRegression: shiftRatio - 1,
			resourcesWithinLimits,
			reproducible,
			shadowPassed,
			parentStillActive: store.head(skillId)?.version.version_id === head.version.version_id,
		};
		const verdict = releaseGate(evidence, gate);
		report.gate = verdict;
		report.release = {
			release_set_id: releaseSetId,
			release_batches: release.length,
			parent_virtual_units: sum(parentRelease.costs),
			candidate_virtual_units: sum(childRelease.costs),
			mean_virtual_cost_reduction: bound.mean,
			lower_bound: bound.lower,
			alpha,
			absolute_gain_per_batch: absoluteGain,
			shifted_cost_ratio: shiftRatio,
			reproducible,
			shadow: shadowNote,
			failures: childRelease.failures.slice(0, 5),
			lineage: search.lineage,
		};
		store.finalizeRelease(releaseSetId, verdict.verdict, report.release);
		store.recordEvaluation(campaignId, candidateHash, "release", report.release, verdict.verdict);

		// Stage H: promote through compare-and-swap, or leave the parent active.
		if (verdict.verdict === "pass") {
			const versionId = store.promote({
				skillId,
				expectedParent: head.version.version_id,
				program: candidate,
				campaignId,
				report: { gate: verdict, release: report.release, lineage: search.lineage },
			});
			report.status = "promoted";
			report.promoted_version = versionId;
			record.accepted_version = versionId;
		} else report.status = verdict.verdict === "incomplete" ? "incomplete" : "rejected";
		store.finishCampaign(campaignId, report.status, record);
		store.audit("campaign_finished", skillId, { campaign: campaignId, status: report.status, gate: verdict });
		return report;
	} catch (error) {
		report.status = "aborted";
		store.finishCampaign(campaignId, "aborted", {
			...record,
			error: error instanceof Error ? error.message : String(error),
		});
		store.audit("campaign_aborted", skillId, {
			campaign: campaignId,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	} finally {
		report.cpu_ms = governor.release(allocation).cpuMs;
	}
}
