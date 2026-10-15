import { defined } from "./defined.ts";
export interface BudgetPolicyConfig {
	contextBudget?: number;
	reserve: number;
	remindAtFractions: readonly number[];
	remindAtReserve: boolean;
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicyConfig = {
	reserve: 2048,
	remindAtFractions: [0.5, 0.75, 0.9],
	remindAtReserve: true,
};

export interface BudgetReading {
	budget: number;
	reserve: number;
	estimated: number;
	estimateExcludes?: string;
	calibration?: number;
	observed?: number;
	observedStale?: boolean;
	source: "config" | "model-window";
}

export interface BudgetTier {
	label: string;
	tokens: number;
}

export function resolveBudgetPolicy(overrides: Partial<BudgetPolicyConfig> | undefined): BudgetPolicyConfig {
	const merged: BudgetPolicyConfig = { ...DEFAULT_BUDGET_POLICY, ...(overrides ?? {}) };
	if (merged.contextBudget !== undefined && (!Number.isFinite(merged.contextBudget) || merged.contextBudget <= 0)) {
		throw new Error(`contextBudget must be a positive number of tokens, got ${String(merged.contextBudget)}`);
	}
	if (!Number.isFinite(merged.reserve) || merged.reserve < 0) {
		throw new Error(`reserve must be a nonnegative number of tokens, got ${String(merged.reserve)}`);
	}
	const fractions = [...merged.remindAtFractions];
	for (const fraction of fractions) {
		if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
			throw new Error(`remindAtFractions entries must be in (0, 1), got ${String(fraction)}`);
		}
	}
	fractions.sort((left, right) => left - right);
	return { ...merged, remindAtFractions: fractions };
}

export function estimateFactorFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env.PI_CLM_ESTIMATE_FACTOR?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 1 || value > 4)
		throw new Error(`PI_CLM_ESTIMATE_FACTOR must be between 1 and 4, got ${raw}`);
	return value;
}

export function budgetPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<BudgetPolicyConfig> {
	const overrides: Partial<BudgetPolicyConfig> = {};
	const budget = env.PI_CLM_BUDGET?.trim();
	if (budget) overrides.contextBudget = Number(budget);
	const reserve = env.PI_CLM_RESERVE?.trim();
	if (reserve) overrides.reserve = Number(reserve);
	const remind = env.PI_CLM_REMIND_AT?.trim();
	if (remind !== undefined && remind !== "") {
		if (remind === "off" || remind === "none") {
			overrides.remindAtFractions = [];
			overrides.remindAtReserve = false;
		} else {
			overrides.remindAtFractions = remind.split(",").map((part) => Number(part.trim()));
		}
	}
	return overrides;
}

export function resolveBudget(
	policy: BudgetPolicyConfig,
	modelContextWindow: number | undefined,
): Pick<BudgetReading, "budget" | "reserve" | "source"> | undefined {
	if (policy.contextBudget !== undefined) {
		const budget =
			modelContextWindow !== undefined && Number.isFinite(modelContextWindow) && modelContextWindow > 0
				? Math.min(policy.contextBudget, modelContextWindow)
				: policy.contextBudget;
		return { budget, reserve: Math.min(policy.reserve, budget), source: "config" };
	}
	if (modelContextWindow !== undefined && Number.isFinite(modelContextWindow) && modelContextWindow > 0) {
		return {
			budget: modelContextWindow,
			reserve: Math.min(policy.reserve, modelContextWindow),
			source: "model-window",
		};
	}
	return undefined;
}

export function budgetTiers(policy: BudgetPolicyConfig, budget: number, reserve: number): BudgetTier[] {
	const tiers: BudgetTier[] = policy.remindAtFractions.map((fraction) => ({
		label: `${Math.round(fraction * 100)}%`,
		tokens: Math.floor(budget * fraction),
	}));
	if (policy.remindAtReserve && reserve > 0 && budget - reserve > 0) {
		tiers.push({ label: "budget-reserve", tokens: budget - reserve });
	}
	tiers.sort((left, right) => left.tokens - right.tokens);
	return tiers.filter((tier, index) => index === tiers.length - 1 || tier.tokens !== tiers[index + 1]?.tokens);
}

export function governingTokens(reading: Pick<BudgetReading, "estimated" | "observed" | "observedStale">): number {
	if (reading.observedStale) return reading.estimated;
	return Math.max(reading.estimated, reading.observed ?? 0);
}

export class BudgetTracker {
	private fired = new Set<string>();
	private tierKey = "";

	reset(): void {
		this.fired.clear();
	}

	observe(reading: BudgetReading, tiers: readonly BudgetTier[]): BudgetTier | undefined {
		const key = tiers.map((tier) => `${tier.label}:${tier.tokens}`).join("|");
		if (key !== this.tierKey) {
			this.tierKey = key;
			this.fired.clear();
		}
		const tokens = governingTokens(reading);
		this.fired = new Set(
			[...this.fired].filter((label) => {
				const tier = tiers.find((candidate) => candidate.label === label);
				return tier !== undefined && tokens >= tier.tokens;
			}),
		);
		const crossed = tiers.filter((tier) => tokens >= tier.tokens && !this.fired.has(tier.label));
		if (crossed.length === 0) return undefined;
		const top = defined(crossed[crossed.length - 1]);
		for (const tier of tiers) if (tier.tokens <= top.tokens) this.fired.add(tier.label);
		return top;
	}
}

function formatTokens(value: number): string {
	return value.toLocaleString("en-US");
}

export function budgetSummaryLine(reading: BudgetReading): string {
	const parts = [
		`budget ${formatTokens(reading.budget)} tok (${reading.source === "config" ? "configured" : "model window"}, reserve ${formatTokens(reading.reserve)})`,
		`estimated next request ${formatTokens(reading.estimated)}${reading.calibration !== undefined && reading.calibration > 1.005 ? ` (×${reading.calibration.toFixed(2)} calibrated)` : ""}`,
	];
	parts.push(
		reading.observed === undefined
			? "observed previous request: unknown"
			: `observed previous request ${formatTokens(reading.observed)}${reading.observedStale ? " (before the last accepted edit)" : ""}`,
	);
	return parts.join(" · ");
}

export function budgetNoticeText(reading: BudgetReading, tier: BudgetTier, mirrorPath: string | undefined): string {
	const governing = governingTokens(reading);
	const remaining = Math.max(0, reading.budget - governing);
	const where = mirrorPath ?? "the context mirror";
	const calibrated =
		reading.calibration !== undefined && reading.calibration > 1.005
			? ` (calibrated ×${reading.calibration.toFixed(2)} from provider counts)`
			: "";
	const excludes = `${calibrated}${reading.estimateExcludes ? `, excluding ${reading.estimateExcludes}` : ""}`;
	const measurement =
		reading.observed === undefined
			? `estimated ${formatTokens(reading.estimated)} tokens for the next request${excludes}; provider-reported size of the previous request unknown`
			: `estimated ${formatTokens(reading.estimated)} tokens for the next request${excludes}; the provider reported ${formatTokens(reading.observed)} for the previous one${reading.observedStale ? ", before your last accepted edit" : ""}`;
	if (tier.label === "budget-reserve") {
		return (
			`[CLM BUDGET] Context is at ${formatTokens(governing)} of a ${formatTokens(reading.budget)}-token budget ` +
			`(${measurement}). Only ${formatTokens(remaining)} tokens remain, which is inside the ${formatTokens(reading.reserve)}-token generation reserve. ` +
			`Edit ${where} now to free space. The budget is a target, not enforced: the request will still be sent and may overflow the provider's actual window.`
		);
	}
	return (
		`[CLM BUDGET] Context crossed ${tier.label} of a ${formatTokens(reading.budget)}-token budget: ${measurement}. ` +
		`${formatTokens(remaining)} tokens remain. You may reorganize ${where} at any time; the final reminder comes at ${formatTokens(reading.budget - reading.reserve)} tokens.`
	);
}

export class EstimateCalibrator {
	private pending: { estimate: number; rawCount: number } | undefined;
	private current = 1;
	private samples = 0;

	private readonly options: { min?: number; max?: number; smoothing?: number; initial?: number };

	constructor(options: { min?: number; max?: number; smoothing?: number; initial?: number } = {}) {
		this.options = options;
		this.current = Math.min(options.max ?? 4, Math.max(options.min ?? 1, options.initial ?? 1));
	}

	get factor(): number {
		return this.current;
	}

	get sampleCount(): number {
		return this.samples;
	}

	reset(): void {
		this.pending = undefined;
		this.current = Math.min(this.options.max ?? 4, Math.max(this.options.min ?? 1, this.options.initial ?? 1));
		this.samples = 0;
	}

	record(estimate: number, rawCount: number): void {
		if (estimate > 0) this.pending = { estimate, rawCount };
	}

	observe(observed: { tokens: number; index: number } | undefined): number {
		if (!observed || !this.pending || observed.index < this.pending.rawCount) return this.current;
		const sample = observed.tokens / this.pending.estimate;
		this.pending = undefined;
		if (!Number.isFinite(sample) || sample <= 0) return this.current;
		const min = this.options.min ?? 1;
		const max = this.options.max ?? 4;
		const smoothing = this.options.smoothing ?? 0.5;
		const next = this.samples === 0 ? sample : this.current * (1 - smoothing) + sample * smoothing;
		this.current = Math.min(max, Math.max(min, next));
		this.samples += 1;
		return this.current;
	}

	apply(estimate: number): number {
		return Math.ceil(estimate * this.current);
	}
}
