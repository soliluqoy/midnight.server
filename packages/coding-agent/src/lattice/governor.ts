import { BUDGETS, type Budget, DAILY_IMPROVEMENT_CPU_MS } from "./limits.ts";
import type { LatticeStore } from "./store.ts";

/**
 * Resource governor (spec sections 14 and 42). Improvement campaigns reserve their maximum CPU
 * allotment in a persisted daily ledger before starting and reconcile measured usage afterwards;
 * a crash leaves the reservation charged, so restarting a worker cannot bypass the daily limit.
 * Durations use the monotonic clock; only the day boundary uses local calendar time.
 */
export type Mode = keyof typeof BUDGETS;

export function localDay(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface Allocation {
	mode: Mode;
	budget: Budget;
	reservationId?: string;
	/** `performance.now()` deadline. */
	deadline: number;
	startedCpuUs: number;
	signal: AbortSignal;
	abort(reason: string): void;
}

export class Governor {
	readonly store: LatticeStore;
	readonly dailyCpuMs: number;

	constructor(store: LatticeStore, dailyCpuMs = DAILY_IMPROVEMENT_CPU_MS) {
		this.store = store;
		this.dailyCpuMs = dailyCpuMs;
	}

	remainingToday(): number {
		return Math.max(0, this.dailyCpuMs - this.store.ledgerCharged(localDay()));
	}

	/** Allocate a budget. Background work reserves CPU from the daily ledger first or is refused. */
	allocate(mode: Mode, override?: Partial<Budget>): Allocation {
		const budget = { ...BUDGETS[mode], ...clampOverride(BUDGETS[mode], override) };
		let reservationId: string | undefined;
		if (mode === "background" || mode === "research") {
			const remaining = this.remainingToday();
			if (remaining < budget.cpuMs) {
				throw new Error(
					`daily improvement budget exhausted (${Math.round(remaining)} of ${this.dailyCpuMs} CPU ms left, ${budget.cpuMs} needed)`,
				);
			}
			reservationId = this.store.ledgerReserve(localDay(), budget.cpuMs);
		}
		const controller = new AbortController();
		return {
			mode,
			budget,
			reservationId,
			deadline: performance.now() + budget.wallMs,
			startedCpuUs: cpuMicros(),
			signal: controller.signal,
			abort: (reason: string) => controller.abort(new Error(reason)),
		};
	}

	/** Reconcile a reservation with the CPU time actually used. */
	release(allocation: Allocation): { cpuMs: number } {
		const cpuMs = (cpuMicros() - allocation.startedCpuUs) / 1000;
		if (allocation.reservationId) this.store.ledgerReconcile(allocation.reservationId, cpuMs);
		return { cpuMs };
	}

	/** True while the allocation is within its CPU and wall budgets and not cancelled. */
	withinBudget(allocation: Allocation): boolean {
		if (allocation.signal.aborted) return false;
		if (performance.now() > allocation.deadline) return false;
		return (cpuMicros() - allocation.startedCpuUs) / 1000 <= allocation.budget.cpuMs;
	}
}

function clampOverride(base: Budget, override: Partial<Budget> | undefined): Partial<Budget> {
	if (!override) return {};
	const out: Partial<Budget> = {};
	for (const key of Object.keys(base) as (keyof Budget)[]) {
		const value = override[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = Math.min(value, base[key]);
	}
	return out;
}

function cpuMicros(): number {
	const usage = process.cpuUsage();
	return usage.user + usage.system;
}

/**
 * Economic gate (spec section 42.4): start a routine optimization only when the expected saving
 * over future calls exceeds the search and validation cost by a margin. Costs are in the same
 * virtual unit; the per-unit time is measured, not assumed.
 */
export function economicGate(args: {
	expectedFutureCalls: number;
	unitsPerCall: number;
	expectedReduction: number;
	searchUnits: number;
	margin?: number;
}): { worthIt: boolean; expectedSavings: number; cost: number; breakEvenCalls: number } {
	const perCall = args.unitsPerCall * args.expectedReduction;
	const expectedSavings = args.expectedFutureCalls * perCall;
	const cost = args.searchUnits;
	const margin = args.margin ?? 1.5;
	return {
		worthIt: expectedSavings > cost * margin,
		expectedSavings,
		cost,
		breakEvenCalls: perCall > 0 ? Math.ceil(cost / perCall) : Number.POSITIVE_INFINITY,
	};
}

/**
 * Upper-confidence selection among already-eligible arms (spec section 9.4). Rewards are
 * normalized to [0, 1]; untried arms are chosen first, which avoids dividing by zero.
 * Exploration here never grants permission: every arm must already be verified equivalent.
 */
export function ucbSelect(
	arms: readonly string[],
	stats: ReadonlyMap<string, { trials: number; reward: number }>,
	exploration = Math.SQRT2,
): string {
	if (arms.length === 0) throw new Error("no eligible arms");
	const untried = arms.find((arm) => (stats.get(arm)?.trials ?? 0) === 0);
	if (untried) return untried;
	const total = arms.reduce((sum, arm) => sum + (stats.get(arm)?.trials ?? 0), 0);
	let best = arms[0];
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const arm of arms) {
		const { trials, reward } = stats.get(arm)!;
		const score = reward / trials + exploration * Math.sqrt(Math.log(total) / trials);
		if (score > bestScore) {
			best = arm;
			bestScore = score;
		}
	}
	return best;
}
