import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "midnight-token-speed";
const UPDATE_INTERVAL_MS = 250;

/** Measure response speed from turn start, including the wait for the first token. */
export function registerTokenSpeed(pi: ExtensionAPI, now: () => number = () => performance.now()): void {
	let started: number | undefined;
	let firstToken: number | undefined;
	let characters = 0;
	let lastUpdate = Number.NEGATIVE_INFINITY;

	const reset = () => {
		started = undefined;
		firstToken = undefined;
		characters = 0;
		lastUpdate = Number.NEGATIVE_INFINITY;
	};
	const clear = (_event: unknown, ctx: ExtensionContext) => {
		reset();
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
	};
	const begin = (ctx: ExtensionContext) => {
		reset();
		started = now();
		ctx.ui.setStatus(STATUS_KEY, "speed · waiting for first token…");
	};
	const render = (ctx: ExtensionContext, time: number, output?: number, outcome = "") => {
		if (started === undefined) return;
		const elapsed = Math.max(0, time - started);
		const estimated = output === undefined && characters > 0;
		const tokens = output ?? (characters > 0 ? characters / 4 : undefined);
		const speed =
			tokens !== undefined && elapsed > 0 ? `${estimated ? "~" : ""}${((tokens * 1000) / elapsed).toFixed(1)}` : "—";
		const ttft = firstToken === undefined ? "—" : `${(Math.max(0, firstToken - started) / 1000).toFixed(2)}s`;
		ctx.ui.setStatus(STATUS_KEY, `${speed} tok/s · ${(elapsed / 1000).toFixed(1)}s · TTFT ${ttft}${outcome}`);
		lastUpdate = time;
	};

	pi.on("session_start", clear);
	pi.on("session_tree", clear);
	pi.on("session_shutdown", clear);
	pi.on("turn_start", (_event, ctx) => {
		if (ctx.mode === "tui") begin(ctx);
	});
	pi.on("message_start", (event, ctx) => {
		if (ctx.mode === "tui" && event.message.role === "assistant" && started === undefined) begin(ctx);
	});
	pi.on("message_update", (event, ctx) => {
		if (ctx.mode !== "tui" || started === undefined || event.message.role !== "assistant") return;
		const delta = event.assistantMessageEvent;
		const time = now();
		if (delta.type === "text_delta" || delta.type === "thinking_delta" || delta.type === "toolcall_delta") {
			if (!delta.delta) return;
			characters += delta.delta.length;
			firstToken ??= time;
		} else if (delta.type === "toolcall_start") {
			// Some providers send the whole tool call at once, not in small pieces.
			firstToken ??= time;
		} else return;
		if (time - lastUpdate >= UPDATE_INTERVAL_MS) render(ctx, time);
	});
	pi.on("message_end", (event, ctx) => {
		if (ctx.mode !== "tui" || started === undefined || event.message.role !== "assistant") return;
		const message = event.message;
		const output = message.usage.output;
		const outcome = message.stopReason === "error" ? " · error" : message.stopReason === "aborted" ? " · aborted" : "";
		// A provider may report zero tokens after an error, even if it sent some text.
		render(
			ctx,
			now(),
			Number.isFinite(output) && output >= 0 && (output > 0 || !characters) ? output : undefined,
			outcome,
		);
		reset();
	});
	pi.on("agent_end", (_event, ctx) => {
		if (started === undefined) return;
		if (ctx.mode === "tui") render(ctx, now(), undefined, " · interrupted");
		reset();
	});
}
