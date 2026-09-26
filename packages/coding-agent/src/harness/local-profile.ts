import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/**
 * Defaults for a small local model. Measured on MiniCPM5-2B (docs/benchmarks/cpu-i7-8650u.md):
 * a 12 KB input produced a wrong answer where a 6 KB one did not, prompt processing runs at
 * ~25-30 tokens/s on a laptop CPU, and sampling at temperature 1 flipped the same answer run
 * to run while greedy decoding was stable. Pi's defaults (50 KB tool output, project context
 * files inlined, provider-default sampling) are sized for frontier models.
 */
export const LOCAL_TOOL_OUTPUT_BYTES = 6_000;
/** Inline project context files only up to this total; above it, list them for the model to read. */
export const LOCAL_CONTEXT_FILE_BYTES = 2_000;

const HEAD_SHARE = 0.4;

/**
 * Cap a tool result's text to `maxBytes`, keeping head and tail, and say how to get the rest.
 * Images pass through unchanged. Returns undefined when nothing needed cutting.
 */
export function capToolOutput(
	content: readonly (TextContent | ImageContent)[],
	toolName: string,
	maxBytes = LOCAL_TOOL_OUTPUT_BYTES,
): (TextContent | ImageContent)[] | undefined {
	const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	const full = Buffer.from(text, "utf8");
	if (full.length <= maxBytes) return undefined;
	const head = Math.floor(maxBytes * HEAD_SHARE);
	const tail = maxBytes - head;
	const hint =
		toolName === "read"
			? "Read a smaller range with offset and limit to see the omitted part."
			: "Narrow the command or search to see the omitted part.";
	const capped = `${full.subarray(0, head).toString("utf8")}\n[... ${full.length - maxBytes} bytes omitted for the local model. ${hint} ...]\n${full.subarray(full.length - tail).toString("utf8")}`;
	return [{ type: "text", text: capped }, ...content.filter((part): part is ImageContent => part.type === "image")];
}

/**
 * Keep small project context files inline; replace large ones with a pointer section.
 * Returns the files to keep and, when any were moved out, a note listing them.
 */
export function splitContextFiles(
	files: ReadonlyArray<{ path: string; content: string }>,
	maxBytes = LOCAL_CONTEXT_FILE_BYTES,
): { keep: Array<{ path: string; content: string }>; note?: string } {
	const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
	if (total <= maxBytes) return { keep: [...files] };
	const listed = files.map((file) => `- ${file.path} (${(Buffer.byteLength(file.content) / 1024).toFixed(1)} KB)`);
	return {
		keep: [],
		note: [
			"Project instruction files exist but are not inlined, to keep the context small. Read the relevant one before changing code conventions, commands or tests:",
			...listed,
		].join("\n"),
	};
}

/**
 * Tools a small local model keeps. Every tool's schema is prompt tokens paid at ~30 tokens/s,
 * and extra tools (MCP gateways, browser automation) are ones a 2B model rarely calls well.
 */
export const LOCAL_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"edit",
	"write",
	"bash",
	"powershell",
	"task",
]);

/** Greedy decoding for OpenAI-compatible payloads that did not set a temperature. */
export function withGreedyDefault(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
	const record = payload as Record<string, unknown>;
	if (record.temperature !== undefined) return payload;
	return { ...record, temperature: 0 };
}
