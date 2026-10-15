import { Worker } from "node:worker_threads";

export const TRIM_REVISION = "f16ff28a9a84bfa7ffa89c12b7e20ad9e4a21c6a";
export const TRIM_MAX_BYTES = 1024 * 1024;
export const TRIM_MAX_LINES = 20000;
export interface TrimResult {
	status: "used" | "skipped" | "fallback";
	reason: string;
	elapsedMs: number;
	scores?: number[];
	kept?: number[];
}
export interface TrimEngine {
	run(text: string, query: string, mode: "rank" | "trim", signal: AbortSignal): Promise<TrimResult>;
	reset(): void;
}

export function trimEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.MIDNIGHT_TRIM !== "off";
}

export class TrimRuntime implements TrimEngine {
	private worker?: Worker;
	private cancel?: () => void;
	private readonly enabled: boolean;
	private readonly timeoutMs: number;
	private readonly workerURL: URL;
	constructor(enabled = trimEnabled(), timeoutMs = 2000, workerURL = new URL("./worker.mjs", import.meta.url)) {
		this.enabled = enabled;
		this.timeoutMs = timeoutMs;
		this.workerURL = workerURL;
	}

	reset(): void {
		this.cancel?.();
		const worker = this.worker;
		this.worker = undefined;
		void worker?.terminate();
	}

	async run(text: string, query: string, mode: "rank" | "trim", signal: AbortSignal): Promise<TrimResult> {
		const start = performance.now();
		const result = (status: TrimResult["status"], reason: string): TrimResult => ({
			status,
			reason,
			elapsedMs: Math.round(performance.now() - start),
		});
		if (signal.aborted) return result("fallback", "cancelled");
		if (!this.enabled) return result("skipped", "disabled");
		const size = Buffer.byteLength(text);
		if (size < 2000 || size > TRIM_MAX_BYTES || text.includes("\0")) return result("skipped", "input_bounds");
		const lines = text.split("\n");
		if (lines.length > TRIM_MAX_LINES) return result("skipped", "line_limit");
		if (/^\s*… \d+ lines? …\s*$/mu.test(text)) return result("skipped", "already_trimmed");
		query = [...query].slice(-2000).join("");
		if (!query.trim()) return result("skipped", "no_query");
		if (this.cancel) return result("fallback", "busy");
		try {
			if (!this.worker) {
				const worker = new Worker(this.workerURL, { resourceLimits: { maxOldGenerationSizeMb: 128 }, execArgv: [] });
				this.worker = worker;
				const clear = () => {
					if (this.worker === worker) this.worker = undefined;
				};
				worker.on("error", clear);
				worker.on("exit", clear);
			}
		} catch {
			return result("fallback", "worker_unavailable");
		}
		const worker = this.worker;
		worker.ref();
		return new Promise((resolve) => {
			let done = false;
			const finish = (value: TrimResult, terminate = false) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				worker.off("message", message);
				worker.off("error", error);
				worker.off("exit", error);
				this.cancel = undefined;
				if (terminate) {
					if (this.worker === worker) this.worker = undefined;
					void worker.terminate();
				} else worker.unref();
				resolve(value);
			};
			const error = () => finish(result("fallback", "worker_unavailable"), true);
			const abort = () => finish(result("fallback", "cancelled"), true);
			const timer = setTimeout(() => finish(result("fallback", "timeout"), true), this.timeoutMs);
			const message = (data: unknown) => {
				if (!data || typeof data !== "object") return error();
				const value = data as { scores?: unknown; kept?: unknown; unchanged?: unknown };
				if (mode === "rank") {
					if (
						!Array.isArray(value.scores) ||
						value.scores.length !== lines.length ||
						!value.scores.every(
							(score) => typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1,
						)
					)
						return error();
					finish({ ...result("used", "ranked"), scores: value.scores });
				} else if (value.unchanged === true) finish(result("skipped", "unchanged"));
				else if (
					value.unchanged === false &&
					Array.isArray(value.kept) &&
					value.kept.length > 0 &&
					value.kept.every(
						(index, i, all) =>
							Number.isSafeInteger(index) && index >= 0 && index < lines.length && (i === 0 || index > all[i - 1]),
					)
				)
					finish({ ...result("used", "balanced"), kept: value.kept });
				else error();
			};
			this.cancel = abort;
			worker.once("message", message);
			worker.once("error", error);
			worker.once("exit", error);
			signal.addEventListener("abort", abort, { once: true });
			try {
				worker.postMessage({ text, query, mode });
			} catch {
				error();
			}
		});
	}
}
