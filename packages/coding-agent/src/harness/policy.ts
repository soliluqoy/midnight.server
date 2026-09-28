import { readFileSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { digest } from "../lattice/canonical.ts";
import type { HarnessConfig } from "./config.ts";
import { FEATURE_NAMES, type FeatureName, type ModelClass } from "./features.ts";

/**
 * The harness policy: the part of the harness's behavior that Lattice-1 may change.
 *
 * Problem: every harness feature and threshold is a guess until it is measured, and a change that
 * helps one model can hurt another. Tuning by hand after each eval is slow, and a tuned default
 * that silently regresses is hard to notice.
 *
 * Solution: the policy is a versioned Lattice record (skill `harness.policy`). A new version is
 * promoted only through a conjunctive gate on the harness's own sessions, first as a canary that is
 * rolled back if live outcomes get worse, then as champion (see lattice/harness-policy.ts). The
 * harness opens the store at session start and records each settled request. Layering, lowest
 * first: model-class defaults, this policy, `harness.json`, `MIDNIGHT_SERVER_HARNESS_FEATURES`. The
 * user's own settings always win.
 *
 * The policy may not switch off the features that guard against drift and broken edits: they are
 * the harness's equivalent of Lattice's kernel-owned evaluator.
 */
export interface PolicyParams {
	/** Repair rounds after failed checks (harness.json `maxRepairRounds`). */
	maxRepairRounds?: number;
	/** Mutants the verifier probe runs per request. */
	mutationMaxMutants?: number;
	/** Wall-time budget of the verifier probe, in seconds. */
	mutationBudgetSeconds?: number;
	/** Similarity at which a rejected attempt counts as repeated. */
	repeatSimilarity?: number;
	/** Highest thinking level a reasoning boost reaches. */
	boostCeiling?: ThinkingLevel;
}

export interface HarnessPolicy {
	/** Feature switches per model class, over the class defaults. */
	features: Partial<Record<ModelClass, Partial<Record<FeatureName, boolean>>>>;
	params: PolicyParams;
}

/** Features the policy can never turn off. */
export const PROTECTED_FEATURES: readonly FeatureName[] = ["blockerExit", "driftGuard", "parseGate"];

export const BOOST_LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high", "xhigh"];

/** Inclusive bounds of numeric parameters: a policy outside them is invalid, not clamped. */
export const PARAM_BOUNDS: Record<
	Exclude<keyof PolicyParams, "boostCeiling">,
	{ min: number; max: number; step: number }
> = {
	maxRepairRounds: { min: 1, max: 4, step: 1 },
	mutationMaxMutants: { min: 2, max: 16, step: 2 },
	mutationBudgetSeconds: { min: 15, max: 300, step: 15 },
	repeatSimilarity: { min: 0.6, max: 0.95, step: 0.05 },
};

/** The human-authored seed: no changes, so the built-in defaults apply. */
export const SEED_POLICY: HarnessPolicy = { features: {}, params: {} };

export class PolicyError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a policy. Unknown keys, protected features switched off and out-of-bounds values throw. */
export function validatePolicy(value: unknown): HarnessPolicy {
	if (!isRecord(value)) throw new PolicyError("policy must be an object");
	for (const key of Object.keys(value)) {
		if (key !== "features" && key !== "params") throw new PolicyError(`unknown policy key "${key}"`);
	}
	const features: HarnessPolicy["features"] = {};
	const rawFeatures = value.features ?? {};
	if (!isRecord(rawFeatures)) throw new PolicyError("features must be an object");
	for (const [modelClass, switches] of Object.entries(rawFeatures)) {
		if (modelClass !== "fast" && modelClass !== "frontier")
			throw new PolicyError(`unknown model class "${modelClass}"`);
		if (!isRecord(switches)) throw new PolicyError(`features.${modelClass} must be an object`);
		const resolved: Partial<Record<FeatureName, boolean>> = {};
		for (const [name, enabled] of Object.entries(switches)) {
			if (!FEATURE_NAMES.includes(name as FeatureName)) throw new PolicyError(`unknown feature "${name}"`);
			if (typeof enabled !== "boolean")
				throw new PolicyError(`features.${modelClass}.${name} must be true or false`);
			if (!enabled && PROTECTED_FEATURES.includes(name as FeatureName)) {
				throw new PolicyError(`the policy may not turn off ${name}`);
			}
			resolved[name as FeatureName] = enabled;
		}
		features[modelClass] = resolved;
	}
	const params: PolicyParams = {};
	const rawParams = value.params ?? {};
	if (!isRecord(rawParams)) throw new PolicyError("params must be an object");
	for (const [key, raw] of Object.entries(rawParams)) {
		if (key === "boostCeiling") {
			if (!BOOST_LEVELS.includes(raw as ThinkingLevel)) {
				throw new PolicyError(`params.boostCeiling must be one of ${BOOST_LEVELS.join(", ")}`);
			}
			params.boostCeiling = raw as ThinkingLevel;
			continue;
		}
		const bounds = PARAM_BOUNDS[key as keyof typeof PARAM_BOUNDS];
		if (!bounds) throw new PolicyError(`unknown parameter "${key}"`);
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw < bounds.min || raw > bounds.max) {
			throw new PolicyError(`params.${key} must be a number from ${bounds.min} to ${bounds.max}`);
		}
		if (bounds.step >= 1 && !Number.isInteger(raw)) throw new PolicyError(`params.${key} must be an integer`);
		params[key as keyof typeof PARAM_BOUNDS] = raw;
	}
	return { features, params };
}

export function policyHash(policy: HarnessPolicy): string {
	return digest(policy);
}

export interface ActivePolicy {
	/**
	 * Where it came from: the Lattice store (the live loop), a file pinned with
	 * `MIDNIGHT_SERVER_HARNESS_POLICY` (evals), or the built-in seed.
	 */
	source: "lattice" | "file" | "seed";
	hash: string;
	policy: HarnessPolicy;
	version?: number;
	status?: string;
	/** In a trial: whether this session runs the active version or the candidate. */
	arm?: "active" | "candidate";
	trial?: string;
	/** Why the store or file policy was not used, when it was not. */
	problem?: string;
}

export function seedPolicy(problem?: string): ActivePolicy {
	return { source: "seed", hash: policyHash(SEED_POLICY), policy: SEED_POLICY, problem };
}

/**
 * The policy pinned for this process with `MIDNIGHT_SERVER_HARNESS_POLICY=<file>`, which is how an
 * eval arm runs a fixed policy; undefined when nothing is pinned. An unreadable or invalid file
 * gives the seed with the reason, never a partial policy.
 */
export function pinnedPolicy(env: NodeJS.ProcessEnv = process.env): ActivePolicy | undefined {
	const path = env.MIDNIGHT_SERVER_HARNESS_POLICY;
	if (!path) return undefined;
	try {
		const policy = validatePolicy(JSON.parse(readFileSync(path, "utf8")));
		return { source: "file", hash: policyHash(policy), policy };
	} catch (error) {
		return seedPolicy(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Whether the harness runs the Lattice loop: on unless `MIDNIGHT_SERVER_HARNESS_LEARN=0`, and never
 * with a pinned policy (an experiment must run exactly what it assigned).
 */
export function learningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const flag = env.MIDNIGHT_SERVER_HARNESS_LEARN?.toLowerCase();
	return flag !== "0" && flag !== "false" && !env.MIDNIGHT_SERVER_HARNESS_POLICY;
}

/** Harness config defaults with the policy's parameters applied; `harness.json` is parsed over this. */
export function policyBaseConfig(base: HarnessConfig, policy: HarnessPolicy): HarnessConfig {
	const { params } = policy;
	return {
		...base,
		maxRepairRounds: params.maxRepairRounds ?? base.maxRepairRounds,
		mutation: {
			maxMutants: params.mutationMaxMutants ?? base.mutation.maxMutants,
			budgetSeconds: params.mutationBudgetSeconds ?? base.mutation.budgetSeconds,
		},
	};
}

/** What one settled request did: the live evidence of the Lattice loop. Stored locally only. */
export interface HarnessEpisode {
	at: number;
	policy_hash: string;
	policy_version?: number;
	model_class: ModelClass;
	/** Whether the settle ladder ran at all in this request. */
	checked: boolean;
	/** The request ended with failing checks. */
	final_failed: boolean;
	/** ...and the model reported a blocker instead of claiming success. */
	blocker: boolean;
	repair_rounds: number;
	rollbacks: number;
	drift_actionable: number;
	escalations: number;
	boosts: number;
	/** Input and output tokens of the request's model calls. */
	tokens?: number;
	probe?: { ran: number; killed: number };
}
