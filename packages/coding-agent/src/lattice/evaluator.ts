import { canonical } from "./canonical.ts";
import { type Bytecode, runBytecode } from "./compile.ts";
import type { Contract } from "./contracts.ts";
import { interpret, type RunResult } from "./interpreter.ts";
import type { LibrarySkill, Program, Value } from "./ir.ts";
import type { ExecutionLimits } from "./limits.ts";
import { type Host, LatticeError } from "./primitives.ts";
import { mean, PyRandom } from "./random.ts";

/**
 * The evaluator is kernel code (spec section 10). It runs a candidate, then judges the output
 * against the contract's oracle and postconditions. The candidate supplies only an output; truth,
 * cost and verdict are computed here from kernel measurements.
 */
export interface CaseResult {
	correct: boolean;
	/** Virtual units, or undefined when the run failed. */
	units?: number;
	/** Why the case failed: an error class or the violated invariant. */
	failure?: string;
}

export interface EvalContext {
	limits: ExecutionLimits;
	library: ReadonlyMap<string, LibrarySkill>;
	bytecode?: Bytecode;
	signal?: AbortSignal;
	deadline?: number;
	/**
	 * The world a case runs against (file contents for `read` effects). Content is never part of
	 * the program's input; the kernel supplies it per case: synthetic for fixtures, the broker for
	 * live directories.
	 */
	host?: (input: Value) => Host;
}

export function execute(program: Program, input: Value, context: EvalContext, host?: Host): RunResult {
	const options = {
		limits: context.limits,
		library: context.library,
		signal: context.signal,
		deadline: context.deadline,
		host: host ?? context.host?.(input),
	};
	return context.bytecode ? runBytecode(context.bytecode, input, options) : interpret(program, input, options);
}

/** Compare a run with the oracle and every postcondition. */
export function judge(contract: Contract, input: Value, run: RunResult, host?: Host): CaseResult {
	if (!run.ok) return { correct: false, failure: `error:${run.error.code}` };
	let expected: Value;
	try {
		expected = contract.oracle(input, host);
	} catch (error) {
		// A live world can change under the oracle too; a case it cannot judge does not pass.
		if (error instanceof LatticeError)
			return { correct: false, units: run.metrics.units, failure: `oracle:${error.code}` };
		throw error;
	}
	if (canonical(run.value) !== canonical(expected)) {
		return { correct: false, units: run.metrics.units, failure: "output differs from oracle" };
	}
	for (const post of contract.postconditions) {
		if (!post.check(input, run.value)) return { correct: false, units: run.metrics.units, failure: post.name };
	}
	return { correct: true, units: run.metrics.units };
}

export function evaluateCase(contract: Contract, program: Program, input: Value, context: EvalContext): CaseResult {
	// One host per case, shared by the candidate and the oracle, so both see the same world.
	const host = (context.host ?? contract.host?.bind(contract))?.(input);
	return judge(contract, input, execute(program, input, context, host), host);
}

export interface SuiteResult {
	allCorrect: boolean;
	costs: number[];
	failures: { index: number; failure: string }[];
	evaluations: number;
}

/**
 * Run a suite. `stopOnFailure` lets the development loop reject early; release evaluation always
 * runs every case, because a missing difficult case must not leave the denominator.
 */
export function evaluateSuite(
	contract: Contract,
	program: Program,
	cases: readonly Value[],
	context: EvalContext,
	stopOnFailure = false,
): SuiteResult {
	const costs: number[] = [];
	const failures: { index: number; failure: string }[] = [];
	let evaluations = 0;
	for (let index = 0; index < cases.length; index++) {
		evaluations++;
		const result = evaluateCase(contract, program, cases[index], context);
		if (!result.correct) {
			failures.push({ index, failure: result.failure ?? "incorrect" });
			if (stopOnFailure) break;
		} else costs.push(result.units ?? 0);
	}
	return { allCorrect: failures.length === 0 && evaluations === cases.length, costs, failures, evaluations };
}

/** g_i = (p_i - c_i) / max(p_i, epsilon), one value per paired batch (spec section 38.5). */
export function pairedGains(parent: readonly number[], child: readonly number[]): number[] {
	if (parent.length !== child.length || parent.length === 0)
		throw new Error("paired costs need equal, non-empty lengths");
	return parent.map((p, index) => (p - child[index]) / Math.max(p, 1));
}

/**
 * Significance for the k-th campaign in a family: alpha_total / (k (k + 1)), which sums to
 * alpha_total over an unbounded sequence (spec section 38.7). With the default alpha_total of
 * 0.02, campaign 1 uses the reference's one-sided 1% bound.
 */
export function alphaForCampaign(k: number, alphaTotal = 0.02): number {
	if (!Number.isInteger(k) || k < 1) throw new Error("campaign index must be a positive integer");
	return alphaTotal / (k * (k + 1));
}

/**
 * Fixed-sample, one-sided percentile-bootstrap lower bound of the mean gain. An approximation
 * conditional on the sampled batches, not a proof (spec section 38.5).
 */
export function bootstrapLowerBound(
	gains: readonly number[],
	options: { resamples?: number; seed?: number; alpha?: number } = {},
): { mean: number; lower: number } {
	const resamples = options.resamples ?? 2000;
	const alpha = options.alpha ?? 0.01;
	const rng = new PyRandom(options.seed ?? 8128);
	const means: number[] = [];
	for (let i = 0; i < resamples; i++) means.push(mean(rng.choices(gains, gains.length)));
	means.sort((a, b) => a - b);
	const index = Math.max(0, Math.ceil(alpha * resamples) - 1);
	return { mean: mean(gains), lower: means[index] };
}

export interface GateThresholds {
	minRelativeGain: number;
	/** Minimum mean virtual units saved per batch, so trivial savings do not promote. */
	minAbsoluteGain: number;
	/** Largest allowed cost increase ratio on the protected (shifted) group. */
	protectedTolerance: number;
}

export const DEFAULT_GATE: GateThresholds = { minRelativeGain: 0.05, minAbsoluteGain: 1, protectedTolerance: 0 };

export interface GateEvidence {
	typecheckPassed: boolean;
	permissionsValid: boolean;
	regressionsPassed: boolean;
	releaseCorrect: boolean;
	improvementLowerBound: number;
	absoluteGain: number;
	/** candidate / parent cost on the protected group, minus 1. */
	worstProtectedRegression: number;
	resourcesWithinLimits: boolean;
	reproducible: boolean;
	shadowPassed: boolean;
	parentStillActive: boolean;
}

export type Verdict = "pass" | "fail" | "incomplete";

/** The production gate is a conjunction, not a weighted average; absent evidence cannot pass (section 38.8). */
export function releaseGate(
	evidence: Partial<GateEvidence>,
	thresholds: GateThresholds = DEFAULT_GATE,
): { verdict: Verdict; reasons: string[] } {
	const required: (keyof GateEvidence)[] = [
		"typecheckPassed",
		"permissionsValid",
		"regressionsPassed",
		"releaseCorrect",
		"improvementLowerBound",
		"absoluteGain",
		"worstProtectedRegression",
		"resourcesWithinLimits",
		"reproducible",
		"shadowPassed",
		"parentStillActive",
	];
	const missing = required.filter((key) => evidence[key] === undefined);
	if (missing.length > 0) return { verdict: "incomplete", reasons: missing.map((key) => `missing ${key}`) };
	const e = evidence as GateEvidence;
	const reasons: string[] = [];
	if (!e.typecheckPassed) reasons.push("typecheck failed");
	if (!e.permissionsValid) reasons.push("permissions invalid");
	if (!e.regressionsPassed) reasons.push("a required regression failed");
	if (!e.releaseCorrect) reasons.push("release output differs from the contract");
	if (!(e.improvementLowerBound >= thresholds.minRelativeGain)) {
		reasons.push(`improvement lower bound ${e.improvementLowerBound.toFixed(4)} < ${thresholds.minRelativeGain}`);
	}
	if (!(e.absoluteGain >= thresholds.minAbsoluteGain)) {
		reasons.push(`absolute gain ${e.absoluteGain.toFixed(2)} units < ${thresholds.minAbsoluteGain}`);
	}
	if (!(e.worstProtectedRegression <= thresholds.protectedTolerance)) {
		reasons.push(`protected group cost regression ${(e.worstProtectedRegression * 100).toFixed(2)}%`);
	}
	if (!e.resourcesWithinLimits) reasons.push("resources over limit");
	if (!e.reproducible) reasons.push("not reproducible on a fresh run");
	if (!e.shadowPassed) reasons.push("shadow phase failed");
	if (!e.parentStillActive) reasons.push("parent is no longer active (stale campaign)");
	return { verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}
