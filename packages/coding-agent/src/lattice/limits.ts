/**
 * Installation policy. Manifests and search policies only request limits; the kernel takes the
 * minimum of each request and these values (spec sections 37.5 and 41.1), so a candidate cannot
 * obtain more resources by writing a larger number into its own record.
 */
export interface ExecutionLimits {
	maxNodes: number;
	maxDepth: number;
	maxItems: number;
	maxSkillCallDepth: number;
	maxStringBytes: number;
	maxOutputBytes: number;
	/** Virtual cost units (sum of primitive charges). */
	maxFuel: number;
	/** Interpreter steps, a separate structural bound. */
	maxSteps: number;
}

export const INSTALLATION_LIMITS: ExecutionLimits = {
	maxNodes: 256,
	maxDepth: 24,
	maxItems: 4096,
	maxSkillCallDepth: 8,
	maxStringBytes: 1_048_576,
	maxOutputBytes: 1_048_576,
	maxFuel: 50_000_000,
	maxSteps: 20_000_000,
};

export function clampLimits(request: Partial<ExecutionLimits>, policy: ExecutionLimits = INSTALLATION_LIMITS) {
	const out = { ...policy };
	for (const key of Object.keys(policy) as (keyof ExecutionLimits)[]) {
		const requested = request[key];
		if (typeof requested === "number" && Number.isFinite(requested) && requested >= 0) {
			out[key] = Math.min(requested, policy[key]);
		}
	}
	return out;
}

/** Budget tiers (spec section 42.1 defaults, which supersede the larger illustrative tiers of section 14). */
export interface Budget {
	wallMs: number;
	cpuMs: number;
	candidateLimit: number;
	evaluationLimit: number;
}

export const BUDGETS: { interactive: Budget; background: Budget; research: Budget; maintenance: Budget } = {
	interactive: { wallMs: 3_000, cpuMs: 1_500, candidateLimit: 32, evaluationLimit: 64 },
	background: { wallMs: 60_000, cpuMs: 10_000, candidateLimit: 256, evaluationLimit: 256 },
	// An explicit, visible profile for level-2 policy campaigns; still reserved from the daily ledger.
	research: { wallMs: 300_000, cpuMs: 100_000, candidateLimit: 256, evaluationLimit: 256 },
	maintenance: { wallMs: 3_600_000, cpuMs: 900_000, candidateLimit: 0, evaluationLimit: 0 },
};

/** CPU milliseconds per local day that improvement campaigns may reserve. */
export const DAILY_IMPROVEMENT_CPU_MS = 120_000;

export const SEARCH_DEFAULTS = {
	maxCandidatesPerCampaign: 256,
	beamWidth: 16,
	maxSearchDepth: 8,
	maxArchiveEntries: 128,
	maxArchivePerFamily: 16,
	maxCounterexamplesPerCampaign: 64,
};
