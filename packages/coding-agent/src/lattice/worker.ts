import { Worker } from "node:worker_threads";
import { getContract } from "./contracts.ts";
import { interpret, type RunResult } from "./interpreter.ts";
import type { LibrarySkill, Program, Value } from "./ir.ts";
import type { ExecutionLimits } from "./limits.ts";
import { makeVerifier, type SearchPolicy, type SearchReport, searchImprovement } from "./search.ts";

/**
 * The isolated replay worker (spec section 4.1). A short-lived worker thread with a heap cap and
 * a wall-clock deadline runs candidate programs. It receives the parent, development and
 * regression cases, the policy and the library; never the store, the policy files or release
 * data, so held-out isolation is a separate data path rather than call order alone.
 *
 * A worker thread bounds memory and time, not privilege: candidates are IR interpreted by kernel
 * code, which has no filesystem or network primitive unless a capability host is passed.
 */
export type WorkerRequest =
	| {
			kind: "search";
			contractId: string;
			parent: Program;
			costCases: Value[];
			checkCases: Value[];
			policy: SearchPolicy;
			limits: ExecutionLimits;
			library: [string, LibrarySkill][];
			seed: number;
			/** Wall milliseconds the search may use. */
			wallMs: number;
			verifierTrials: number;
	  }
	| {
			kind: "execute";
			program: Program;
			input: Value;
			limits: ExecutionLimits;
			library: [string, LibrarySkill][];
			wallMs: number;
	  };

export type WorkerResponse = { kind: "search"; report: SearchReport } | { kind: "execute"; result: RunResult };

/** Runs inside the worker (and inline when isolation is off). */
export function handleRequest(request: WorkerRequest): WorkerResponse {
	const library = new Map(request.library);
	const deadline = performance.now() + request.wallMs;
	if (request.kind === "execute") {
		return {
			kind: "execute",
			result: interpret(request.program, request.input, { limits: request.limits, library, deadline }),
		};
	}
	const contract = getContract(request.contractId);
	const context = { limits: request.limits, library, deadline };
	const verifier =
		contract.fuzz && request.verifierTrials > 0
			? makeVerifier(contract, context, contract.fuzz, { seed: request.seed + 1, trials: request.verifierTrials })
			: undefined;
	return {
		kind: "search",
		report: searchImprovement({
			contract,
			parent: request.parent,
			costCases: request.costCases,
			checkCases: request.checkCases,
			policy: request.policy,
			limits: request.limits,
			library,
			seed: request.seed,
			deadline,
			verifier,
		}),
	};
}

export interface IsolationOptions {
	/** V8 old-generation heap cap for the worker. */
	memoryMb: number;
	/** Extra wall time past the request's own deadline before the worker is terminated. */
	graceMs: number;
}

export const DEFAULT_ISOLATION: IsolationOptions = { memoryMb: 128, graceMs: 2_000 };

/** Run a request in a fresh worker thread and discard the worker afterwards. */
export function runIsolated(
	request: WorkerRequest,
	options: IsolationOptions = DEFAULT_ISOLATION,
	signal?: AbortSignal,
): Promise<WorkerResponse> {
	const entry = new URL(import.meta.url.endsWith(".ts") ? "./worker-entry.ts" : "./worker-entry.js", import.meta.url);
	return new Promise((resolve, reject) => {
		const worker = new Worker(entry, {
			workerData: request,
			resourceLimits: { maxOldGenerationSizeMb: options.memoryMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
			stdout: true,
			stderr: true,
		});
		let settled = false;
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			action();
			void worker.terminate();
		};
		const timer = setTimeout(
			() => finish(() => reject(new Error("worker deadline exceeded"))),
			request.wallMs + options.graceMs,
		);
		const cancel = () => finish(() => reject(new Error("cancelled: interactive work has priority")));
		if (signal?.aborted) cancel();
		signal?.addEventListener("abort", cancel, { once: true });
		worker.once("message", (message: WorkerResponse) => finish(() => resolve(message)));
		worker.once("error", (error) => finish(() => reject(error)));
		worker.once("exit", (code) => finish(() => reject(new Error(`worker exited with code ${code} before replying`))));
	});
}
