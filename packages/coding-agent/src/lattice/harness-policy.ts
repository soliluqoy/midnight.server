import { FEATURE_NAMES, type FeatureName, type ModelClass, resolveFeatures } from "../harness/features.ts";
import {
	BOOST_LEVELS,
	type HarnessEpisode,
	type HarnessPolicy,
	PARAM_BOUNDS,
	type PolicyParams,
	PROTECTED_FEATURES,
	policyHash,
	SEED_POLICY,
	validatePolicy,
} from "../harness/policy.ts";
import { digest } from "./canonical.ts";
import { alphaForCampaign } from "./evaluator.ts";
import { ucbSelect } from "./governor.ts";
import { defaultDataDir } from "./paths.ts";
import { mean, PyRandom } from "./random.ts";
import { LatticeStore } from "./store.ts";

/**
 * Lattice-1 as the harness's core: the harness improves its own policy from the sessions it runs.
 *
 * Problem: every harness feature and threshold is a guess until measured, and what helps one model
 * can hurt another. Tuning by hand is slow, and a default that silently regresses goes unnoticed.
 *
 * Solution: the harness policy (harness/policy.ts) is a versioned `policy` record under the skill
 * `harness.policy` in the Lattice store, handled by the same kernel machinery as every skill: a
 * human-authored seed (the built-in defaults), candidates made by one small typed mutation of the
 * active version, evidence consumed once, a conjunctive gate, compare-and-swap promotion into a
 * canary, rollback as a pointer change, and an audit record for each decision.
 *
 * The evidence is the harness's own sessions. While a trial runs, each new session is assigned at
 * random to the active policy or to one candidate, and every settled request adds an episode: did
 * it end resolved (checks pass, or a reported blocker) without actionable drift, and at what token
 * cost. When both arms have enough episodes the gate decides. A promoted candidate first serves as
 * a canary and is rolled back if live outcomes get worse than its parent's. Nothing here needs a
 * command: the harness opens the store at session start and records at settle.
 *
 * Limits, stated plainly: live outcomes have no hidden grader, so "resolved" is a proxy. The gate
 * therefore also refuses any candidate that raises drift, and the searchable space excludes the
 * features that guard against drift and broken edits (PROTECTED_FEATURES) and escalation, which
 * spends money on another model.
 */

export const HARNESS_POLICY_SKILL = "harness.policy";
export const HARNESS_POLICY_CONTRACT = { id: "harness.policy", revision: 1 };
/** The evaluations suite that holds live episodes. */
export const LIVE_SUITE = "harness/live";
const TRIAL_KIND = "harness-trial";

export const TRIAL = {
	/** Episodes with checks per arm before the gate decides. */
	minEpisodes: 30,
	/** Per arm; a trial still undecided here ends as inconclusive or rejected. */
	maxEpisodes: 300,
	/** Episodes of the active version between the end of one trial and the start of the next. */
	cooldownEpisodes: 20,
	/** Total one-sided alpha over all trials; trial k uses alphaTotal / (k (k + 1)). */
	alphaTotal: 0.2,
	/** Route 2: resolved no worse than this (lower bound) and tokens lower by at least minCostReduction. */
	nonInferiorityMargin: 0.03,
	minCostReduction: 0.1,
	/** Never promote a candidate whose episodes cost this much more on average. */
	maxCostIncrease: 0.5,
	resamples: 2000,
	seed: 8128,
};

export const CANARY = {
	/** Canary episodes with checks before it can be rolled back. */
	minEpisodes: 15,
	/** Canary episodes before one that is not worse becomes the champion. */
	confirmEpisodes: 40,
	/** Roll back when the canary's resolved rate falls below its parent's by more than this. */
	failureMargin: 0.1,
};

export function harnessEvaluatorHash(): string {
	return digest({ trial: TRIAL, canary: CANARY, metric: "resolved-without-drift, tokens", v: 2 });
}

/* ---------------------------------------------------------------------------- candidates */

const PARAM_DEFAULTS: Required<Omit<PolicyParams, "boostCeiling">> & { boostCeiling: (typeof BOOST_LEVELS)[number] } = {
	maxRepairRounds: 2,
	mutationMaxMutants: 6,
	mutationBudgetSeconds: 60,
	repeatSimilarity: 0.8,
	boostCeiling: "high",
};

/**
 * Features a trial may switch. Protected features stay on; `masking` follows harness.json;
 * `escalation` spends money on another model, which the user decides.
 */
export const SEARCHABLE_FEATURES: readonly FeatureName[] = FEATURE_NAMES.filter(
	(name) => !PROTECTED_FEATURES.includes(name) && name !== "masking" && name !== "escalation",
);

const MODEL_CLASSES: readonly ModelClass[] = ["fast", "frontier"];

export interface Candidate {
	/** The mutation operator; also the bandit arm that learns which kinds of change pay. */
	operator: string;
	policy: HarnessPolicy;
	hash: string;
}

function round(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

/** Every one-step mutation of `parent`: toggle one feature for one model class, or step one parameter. */
export function policyMutations(parent: HarnessPolicy): Candidate[] {
	const out: Candidate[] = [];
	const add = (operator: string, policy: HarnessPolicy) => {
		const valid = validatePolicy(policy);
		out.push({ operator, policy: valid, hash: policyHash(valid) });
	};
	for (const modelClass of MODEL_CLASSES) {
		const resolved = resolveFeatures(modelClass, {}, {}, parent.features[modelClass]);
		for (const name of SEARCHABLE_FEATURES) {
			add(`toggle:${modelClass}:${name}`, {
				features: { ...parent.features, [modelClass]: { ...parent.features[modelClass], [name]: !resolved[name] } },
				params: parent.params,
			});
		}
	}
	for (const key of Object.keys(PARAM_BOUNDS) as (keyof typeof PARAM_BOUNDS)[]) {
		const bounds = PARAM_BOUNDS[key];
		const current = parent.params[key] ?? PARAM_DEFAULTS[key];
		for (const [direction, next] of [
			["up", round(current + bounds.step)],
			["down", round(current - bounds.step)],
		] as const) {
			if (next < bounds.min || next > bounds.max) continue;
			add(`step:${key}:${direction}`, { features: parent.features, params: { ...parent.params, [key]: next } });
		}
	}
	const ceiling = BOOST_LEVELS.indexOf(parent.params.boostCeiling ?? PARAM_DEFAULTS.boostCeiling);
	for (const [direction, index] of [
		["up", ceiling + 1],
		["down", ceiling - 1],
	] as const) {
		if (index < 0 || index >= BOOST_LEVELS.length) continue;
		add(`step:boostCeiling:${direction}`, {
			features: parent.features,
			params: { ...parent.params, boostCeiling: BOOST_LEVELS[index] },
		});
	}
	return out;
}

/** The model class an operator is about, when it toggles a per-class feature. */
function operatorClass(operator: string): ModelClass | undefined {
	const [kind, modelClass] = operator.split(":");
	return kind === "toggle" && (modelClass === "fast" || modelClass === "frontier") ? modelClass : undefined;
}

/* ----------------------------------------------------------------------------- episodes */

/** A settled request as evidence: resolved without drift, and its token cost. */
export function episodeOutcome(episode: HarnessEpisode): { resolved: number; tokens: number; drift: number } {
	return {
		resolved: (!episode.final_failed || episode.blocker) && episode.drift_actionable === 0 ? 1 : 0,
		tokens: episode.tokens ?? 0,
		drift: episode.drift_actionable > 0 ? 1 : 0,
	};
}

/**
 * One-sided lower bound of mean(candidate) - mean(parent) for independent samples (or, relative,
 * of the fraction by which the candidate's mean is lower), by a seeded percentile bootstrap that
 * resamples each arm separately.
 */
export function differenceLowerBound(
	parent: readonly number[],
	candidate: readonly number[],
	alpha: number,
	options: { resamples?: number; seed?: number; relative?: boolean } = {},
): { estimate: number; lower: number } {
	const rng = new PyRandom(options.seed ?? TRIAL.seed);
	const resamples = options.resamples ?? TRIAL.resamples;
	const statistic = (p: readonly number[], c: readonly number[]) => {
		const mp = mean(p);
		const mc = mean(c);
		return options.relative ? (mp > 0 ? (mp - mc) / mp : 0) : mc - mp;
	};
	const draws: number[] = [];
	for (let index = 0; index < resamples; index++) {
		draws.push(statistic(rng.choices(parent, parent.length), rng.choices(candidate, candidate.length)));
	}
	draws.sort((a, b) => a - b);
	return { estimate: statistic(parent, candidate), lower: draws[Math.max(0, Math.ceil(alpha * resamples) - 1)] };
}

export type Verdict = "pass" | "fail" | "incomplete";

export interface TrialGate {
	verdict: Verdict;
	route?: "success" | "cost";
	reasons: string[];
	alpha: number;
	episodes: { parent: number; candidate: number };
	resolved: { parent: number; candidate: number; lower?: number };
	tokenReduction?: { estimate: number; lower: number };
	drift: { parent: number; candidate: number };
}

/**
 * The gate: a conjunction, and absent evidence cannot pass. A candidate passes when its resolved
 * rate is significantly higher, or when it is no worse (within the margin) and significantly
 * cheaper in tokens; either way its drift rate may not rise and its cost may not grow past a cap.
 */
export function trialGate(
	parent: readonly HarnessEpisode[],
	candidate: readonly HarnessEpisode[],
	trialIndex: number,
	parentStillActive: boolean,
): TrialGate {
	const alpha = alphaForCampaign(trialIndex, TRIAL.alphaTotal);
	const p = parent.map(episodeOutcome);
	const c = candidate.map(episodeOutcome);
	const rate = (list: typeof p, field: "resolved" | "drift") =>
		list.length > 0 ? mean(list.map((item) => item[field])) : 0;
	const gate: TrialGate = {
		verdict: "incomplete",
		reasons: [],
		alpha,
		episodes: { parent: p.length, candidate: c.length },
		resolved: { parent: rate(p, "resolved"), candidate: rate(c, "resolved") },
		drift: { parent: rate(p, "drift"), candidate: rate(c, "drift") },
	};
	if (p.length < TRIAL.minEpisodes || c.length < TRIAL.minEpisodes) {
		gate.reasons.push(`${p.length} and ${c.length} episodes; each arm needs ${TRIAL.minEpisodes}`);
		return gate;
	}
	const resolved = differenceLowerBound(
		p.map((item) => item.resolved),
		c.map((item) => item.resolved),
		alpha,
	);
	gate.resolved.lower = resolved.lower;
	if (p.some((item) => item.tokens > 0) && c.some((item) => item.tokens > 0)) {
		gate.tokenReduction = differenceLowerBound(
			p.map((item) => item.tokens),
			c.map((item) => item.tokens),
			alpha,
			{ relative: true },
		);
	}
	if (resolved.lower > 0) gate.route = "success";
	else if (
		resolved.lower >= -TRIAL.nonInferiorityMargin &&
		gate.tokenReduction !== undefined &&
		gate.tokenReduction.lower >= TRIAL.minCostReduction
	) {
		gate.route = "cost";
	} else {
		gate.reasons.push(
			`no significant gain: resolved lower bound ${resolved.lower.toFixed(4)}, token reduction lower bound ${gate.tokenReduction ? gate.tokenReduction.lower.toFixed(4) : "n/a"} (alpha ${alpha.toFixed(4)})`,
		);
	}
	if (gate.drift.candidate > gate.drift.parent) gate.reasons.push("drift rose");
	if (gate.tokenReduction && -gate.tokenReduction.estimate > TRIAL.maxCostIncrease) {
		gate.reasons.push(`tokens rose ${(-gate.tokenReduction.estimate * 100).toFixed(1)}%`);
	}
	if (!parentStillActive) gate.reasons.push("parent is no longer active (stale trial)");
	gate.verdict = gate.reasons.length === 0 ? "pass" : "fail";
	return gate;
}

/** Whether the point estimates allow a pass on either route; the lower bounds are never higher. */
function mayPass(parent: readonly HarnessEpisode[], candidate: readonly HarnessEpisode[]): boolean {
	const p = parent.map(episodeOutcome);
	const c = candidate.map(episodeOutcome);
	const gain = mean(c.map((item) => item.resolved)) - mean(p.map((item) => item.resolved));
	if (gain > 0) return true;
	const parentTokens = mean(p.map((item) => item.tokens));
	const reduction = parentTokens > 0 ? (parentTokens - mean(c.map((item) => item.tokens))) / parentTokens : 0;
	return gain >= -TRIAL.nonInferiorityMargin && reduction >= TRIAL.minCostReduction;
}

/* --------------------------------------------------------------------------------- core */

interface TrialRecord {
	parent: { version: number; hash: string };
	candidate: { operator: string; hash: string };
	gate?: TrialGate;
	outcome?: string;
}

/** Which policy a session runs. */
export interface Assignment {
	arm: "active" | "candidate";
	version: number;
	status: string;
	policy: HarnessPolicy;
	hash: string;
	/** The running trial, when there is one. */
	trial?: string;
}

/** What a step changed, if anything. */
export interface Decision {
	kind: "trial_started" | "promoted" | "rejected" | "inconclusive" | "aborted" | "confirmed" | "rolled_back";
	detail: string;
	gate?: TrialGate;
}

interface ActiveVersion {
	version: number;
	status: string;
	parent: number | null;
	createdAt: number;
	policy: HarnessPolicy;
	hash: string;
}

const BANDIT_PREFIX = `${HARNESS_POLICY_SKILL}/op/`;

export class HarnessPolicyCore {
	readonly store: LatticeStore;

	private constructor(store: LatticeStore) {
		this.store = store;
	}

	/** Open the store (created on first use) and make sure the seed exists. */
	static open(dataDir = defaultDataDir(), options: { memory?: boolean } = {}): HarnessPolicyCore {
		const store = options.memory ? LatticeStore.memory(dataDir) : LatticeStore.open(dataDir);
		try {
			installHarnessPolicy(store);
		} catch (error) {
			store.close();
			throw error;
		}
		return new HarnessPolicyCore(store);
	}

	close(): void {
		this.store.close();
	}

	active(): ActiveVersion {
		const head = this.store.headRecord<HarnessPolicy>(HARNESS_POLICY_SKILL)!;
		const policy = validatePolicy(head.record);
		return {
			version: head.version.version_id,
			status: head.version.status,
			parent: head.version.parent_version,
			createdAt: head.version.created_at,
			policy,
			hash: policyHash(policy),
		};
	}

	/** The running trial, if any. A trial whose parent is no longer active is aborted here. */
	private trial(active: ActiveVersion): { id: string; record: TrialRecord; policy: HarnessPolicy } | undefined {
		const row = this.store
			.campaigns(HARNESS_POLICY_SKILL)
			.find((campaign) => campaign.kind === TRIAL_KIND && campaign.status === "paused");
		if (!row) return undefined;
		const record = JSON.parse(row.record_json) as TrialRecord;
		if (record.parent.version !== active.version) {
			record.outcome = "aborted";
			this.store.finishCampaign(row.campaign_id, "aborted", record);
			this.store.audit("harness_trial_aborted", HARNESS_POLICY_SKILL, {
				trial: row.campaign_id,
				reason: "parent changed",
			});
			return undefined;
		}
		const policy = validatePolicy(JSON.parse(this.store.programText(record.candidate.hash)!));
		return { id: row.campaign_id, record, policy };
	}

	/** Assign a session: during a trial, active or candidate with equal probability; otherwise active. */
	assign(random: () => number = Math.random): Assignment {
		const active = this.active();
		const trial = this.trial(active);
		if (trial && random() < 0.5) {
			return {
				arm: "candidate",
				version: active.version,
				status: "trial",
				policy: trial.policy,
				hash: trial.record.candidate.hash,
				trial: trial.id,
			};
		}
		return {
			arm: "active",
			version: active.version,
			status: active.status,
			policy: active.policy,
			hash: active.hash,
			trial: trial?.id,
		};
	}

	/** Store one settled request under the policy it ran, then let the kernel decide what follows. */
	record(assignment: Assignment, episode: HarnessEpisode): Decision | undefined {
		const outcome = episodeOutcome(episode);
		this.store.recordEvaluation(
			assignment.trial ?? null,
			assignment.hash,
			LIVE_SUITE,
			{ ...episode, arm: assignment.arm },
			episode.checked ? (outcome.resolved ? "resolved" : "unresolved") : "unchecked",
		);
		return this.step();
	}

	/** Checked episodes of a policy, optionally within one trial, one model class, or since a time. */
	private episodes(
		hash: string,
		filter: { trial?: string; modelClass?: ModelClass; since?: number } = {},
	): HarnessEpisode[] {
		return this.store
			.evaluationsOf(LIVE_SUITE, { programHash: hash, campaignId: filter.trial })
			.filter((row) => filter.since === undefined || row.created_at >= filter.since)
			.map((row) => row.metrics as HarnessEpisode)
			.filter((episode) => episode.checked && (!filter.modelClass || episode.model_class === filter.modelClass));
	}

	/**
	 * Decide what the evidence allows: judge a running trial, watch a canary, or start the next
	 * trial after a cooldown. Safe to call from several sessions at once: a trial's evidence is
	 * reserved as a release set before it is judged, so only one caller decides it, a trial starts
	 * under the write lock, and promotion is a compare-and-swap on the active version.
	 */
	step(): Decision | undefined {
		if (this.store.paused) return undefined;
		const active = this.active();
		const trial = this.trial(active);
		if (trial) return this.judge(trial, active);
		if (active.status === "canary") return this.watchCanary(active);
		return this.maybeStartTrial(active);
	}

	private judge(
		trial: { id: string; record: TrialRecord; policy: HarnessPolicy },
		active: ActiveVersion,
	): Decision | undefined {
		const modelClass = operatorClass(trial.record.candidate.operator);
		const parent = this.episodes(trial.record.parent.hash, { trial: trial.id, modelClass });
		const candidate = this.episodes(trial.record.candidate.hash, { trial: trial.id, modelClass });
		if (parent.length < TRIAL.minEpisodes || candidate.length < TRIAL.minEpisodes) return undefined;
		const exhausted = parent.length >= TRIAL.maxEpisodes && candidate.length >= TRIAL.maxEpisodes;
		// Before the cap only a pass is acted on, and a pass needs the point estimate on its side: skip
		// the bootstrap when it is not (most requests during a trial).
		if (!exhausted && !mayPass(parent, candidate)) return undefined;
		const trialIndex = this.store.releaseSetsUsed(`${HARNESS_POLICY_SKILL}/live/`) + 1;
		const gate = trialGate(parent, candidate, trialIndex, active.version === trial.record.parent.version);
		// A trial that has not passed may still pass with more evidence: judge only a pass, or at the cap.
		if (gate.verdict !== "pass" && !exhausted) return undefined;
		const releaseSetId = `${HARNESS_POLICY_SKILL}/live/${trial.id}`;
		try {
			this.store.reserveRelease(releaseSetId, trial.id, trial.record.candidate.hash);
		} catch {
			return undefined; // Another session is deciding this trial.
		}
		this.store.finalizeRelease(releaseSetId, gate.verdict, gate);
		trial.record.gate = gate;
		const operatorArm = `${BANDIT_PREFIX}${trial.record.candidate.operator}`;
		if (gate.verdict !== "pass") {
			const kind = gate.verdict === "fail" ? "rejected" : "inconclusive";
			trial.record.outcome = kind;
			this.store.finishCampaign(trial.id, gate.verdict === "fail" ? "rejected" : "incomplete", trial.record);
			this.store.banditUpdate(operatorArm, 0);
			return { kind, detail: trial.record.candidate.operator, gate };
		}
		try {
			const version = this.store.promote({
				skillId: HARNESS_POLICY_SKILL,
				expectedParent: trial.record.parent.version,
				program: trial.policy,
				kind: "policy",
				campaignId: trial.id,
				report: { operator: trial.record.candidate.operator, gate },
			});
			trial.record.outcome = "promoted";
			this.store.finishCampaign(trial.id, "promoted", trial.record);
			this.store.banditUpdate(operatorArm, 1);
			return { kind: "promoted", detail: `${trial.record.candidate.operator} as version ${version} (canary)`, gate };
		} catch (error) {
			trial.record.outcome = "aborted";
			this.store.finishCampaign(trial.id, "aborted", trial.record);
			return { kind: "aborted", detail: error instanceof Error ? error.message : String(error) };
		}
	}

	private watchCanary(active: ActiveVersion): Decision | undefined {
		if (active.parent === null) return undefined;
		const parentVersion = this.store.version(active.parent)!;
		const parentHash = policyHash(validatePolicy(JSON.parse(this.store.programText(parentVersion.program_hash)!)));
		const canary = this.episodes(active.hash, { since: active.createdAt });
		if (canary.length < CANARY.minEpisodes) return undefined;
		const parent = this.episodes(parentHash);
		const rate = (list: HarnessEpisode[]) =>
			list.length === 0 ? 1 : mean(list.map((item) => episodeOutcome(item).resolved));
		const canaryRate = rate(canary);
		const parentRate = rate(parent);
		if (canaryRate < parentRate - CANARY.failureMargin) {
			const detail = `canary resolved ${canaryRate.toFixed(3)} against parent ${parentRate.toFixed(3)} over ${canary.length} episodes`;
			this.store.rollback(HARNESS_POLICY_SKILL, detail);
			return { kind: "rolled_back", detail };
		}
		if (canary.length >= CANARY.confirmEpisodes) {
			this.store.confirmChampion(HARNESS_POLICY_SKILL, active.version, {
				canary: canaryRate,
				parent: parentRate,
				episodes: canary.length,
			});
			return { kind: "confirmed", detail: `version ${active.version}` };
		}
		return undefined;
	}

	private maybeStartTrial(active: ActiveVersion): Decision | undefined {
		const lastTrial = this.store
			.campaigns(HARNESS_POLICY_SKILL)
			.filter((campaign) => campaign.kind === TRIAL_KIND)
			.at(-1);
		const since = Math.max(lastTrial?.created_at ?? 0, active.createdAt);
		const recent = this.episodes(active.hash, { since });
		if (recent.length < TRIAL.cooldownEpisodes) return undefined;
		return this.store.transaction(() => {
			// Checked again inside the write lock: another session may have started one meanwhile.
			const running = this.store
				.campaigns(HARNESS_POLICY_SKILL)
				.some((campaign) => campaign.kind === TRIAL_KIND && campaign.status === "paused");
			if (running) return undefined;
			const [candidate] = proposeCandidates(this.store, active.policy, 1, recent.length * 31 + active.version);
			if (!candidate) return undefined;
			this.store.putPolicyRecord(candidate.policy);
			const trialId = `htrial_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
			const record: TrialRecord = {
				parent: { version: active.version, hash: active.hash },
				candidate: { operator: candidate.operator, hash: candidate.hash },
			};
			this.store.startCampaign({
				campaignId: trialId,
				skillId: HARNESS_POLICY_SKILL,
				kind: TRIAL_KIND,
				parentVersion: active.version,
				record,
			});
			// A trial spans many processes; `paused` keeps open-time reconciliation from aborting it.
			this.store.finishCampaign(trialId, "paused", record);
			return { kind: "trial_started" as const, detail: candidate.operator };
		});
	}

	/** One line for `/harness`: the active version and the running trial with its evidence so far. */
	summary(): string {
		const active = this.active();
		const trial = this.trial(active);
		const parts = [`${HARNESS_POLICY_SKILL} v${active.version} (${active.status})`];
		if (trial) {
			const modelClass = operatorClass(trial.record.candidate.operator);
			const p = this.episodes(trial.record.parent.hash, { trial: trial.id, modelClass }).length;
			const c = this.episodes(trial.record.candidate.hash, { trial: trial.id, modelClass }).length;
			parts.push(
				`trial of ${trial.record.candidate.operator}: ${p} and ${c} of ${TRIAL.minEpisodes} episodes per arm`,
			);
		}
		return parts.join("; ");
	}
}

/** Install the seed (the built-in defaults). Idempotent. */
export function installHarnessPolicy(store: LatticeStore): number {
	store.ensureContractRow(HARNESS_POLICY_CONTRACT.id, HARNESS_POLICY_CONTRACT.revision, harnessEvaluatorHash());
	return store.installSeed(HARNESS_POLICY_SKILL, HARNESS_POLICY_CONTRACT, SEED_POLICY, "policy");
}

/** Hashes of candidates earlier trials did not promote: evidence is never paid for twice. */
function rejectedHashes(store: LatticeStore): Set<string> {
	const hashes = new Set<string>();
	for (const row of store.campaigns(HARNESS_POLICY_SKILL)) {
		if (row.kind !== TRIAL_KIND || row.status === "paused" || row.status === "promoted") continue;
		hashes.add((JSON.parse(row.record_json) as TrialRecord).candidate.hash);
	}
	return hashes;
}

/**
 * Pick `count` candidates: operators by upper-confidence bound over past trials (reward 1 when a
 * candidate of that operator was promoted), untried operators first in a seeded order.
 */
export function proposeCandidates(
	store: LatticeStore,
	parent: HarnessPolicy,
	count: number,
	seed: number,
): Candidate[] {
	const rejected = rejectedHashes(store);
	const pool = policyMutations(parent).filter((candidate) => !rejected.has(candidate.hash));
	const rng = new PyRandom(seed);
	for (let index = pool.length - 1; index > 0; index--) {
		const other = rng.randrange(index + 1);
		[pool[index], pool[other]] = [pool[other], pool[index]];
	}
	const stats = new Map<string, { trials: number; reward: number }>(
		store.banditArms(BANDIT_PREFIX).map((row) => [row.arm.slice(BANDIT_PREFIX.length), row]),
	);
	const chosen: Candidate[] = [];
	while (chosen.length < count && pool.length > 0) {
		const operator = ucbSelect(
			pool.map((candidate) => candidate.operator),
			stats,
		);
		const index = pool.findIndex((candidate) => candidate.operator === operator);
		chosen.push(pool.splice(index, 1)[0]);
		const row = stats.get(operator) ?? { trials: 0, reward: 0 };
		stats.set(operator, { trials: row.trials + 1, reward: row.reward });
	}
	return chosen;
}
