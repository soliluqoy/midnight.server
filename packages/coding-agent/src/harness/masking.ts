import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ContextEditEntryDraft } from "../core/extensions/types.ts";
import type { ProjectedSessionEntry } from "../core/session-manager.ts";
import type { MaskingSettings } from "./config.ts";

/**
 * Observation masking: replace old, large tool results in model context with a one-line
 * stub. The full result stays in the session file; only its contribution to later requests
 * shrinks.
 *
 * Problem: a session that reads ten 15 KB files carries all 150 KB into every later
 * request, although after a few turns the model has used what it needed. Example: turn 3
 * reads `src/app.ts` (15 KB) to find one function; turns 4-40 each resend those 15 KB.
 * Replacing that result with `[read {"path":"src/app.ts"} output elided (15.0 KB)...]`
 * saves ~3.7K tokens on every later request, and the model can read the file again if it
 * needs it (the file is the source of truth, not the old tool result).
 *
 * Research on software-engineering agents found this simple masking about as effective as
 * summarizing old history with a model, at lower cost, and it needs no model call at all.
 *
 * Elision happens through append-only `context_edit` entries, so it is persistent,
 * branch-aware (it follows /tree), and visible in the session file.
 *
 * Thresholds scale with the model's context window. Fixed byte thresholds sized for a
 * 200K-token window never trigger in an 8K window: "keep the newest 6 results" of 6 KB each
 * is already more than the whole 8K window.
 */

/** Tools whose results are never elided: they hold state the model must keep seeing. */
const NEVER_ELIDE = new Set(["task"]);

const IMAGE_BYTES = 50_000;

/** Rough bytes per token for code and English, used only to relate bytes to a token window. */
export const BYTES_PER_TOKEN = 4;

/** Share of the window at which a batch is elided, and the most the newest results may keep. */
const BATCH_WINDOW_SHARE = 0.15;
const KEEP_WINDOW_SHARE = 0.25;
const MIN_RESULT_WINDOW_SHARE = 0.02;

function contentBytes(content: readonly (TextContent | ImageContent)[]): number {
	let bytes = 0;
	for (const part of content) bytes += part.type === "text" ? Buffer.byteLength(part.text) : IMAGE_BYTES;
	return bytes;
}

function contentLines(content: readonly (TextContent | ImageContent)[]): number {
	let lines = 0;
	for (const part of content) if (part.type === "text") lines += part.text.split("\n").length;
	return lines;
}

function compactArgs(args: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(args) ?? "";
	} catch {
		text = "";
	}
	return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

export function elisionStub(toolName: string, args: unknown, bytes: number, lines?: number): string {
	const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} bytes`;
	const shown = compactArgs(args);
	const lineNote = lines !== undefined && lines > 1 ? `, ${lines} lines` : "";
	return `[${toolName}${shown ? ` ${shown}` : ""} output elided by the harness to save context (${size}${lineNote}). Call the tool again if you need this content.]`;
}

export interface MaskingPlan {
	edits: ContextEditEntryDraft[];
	elidedBytes: number;
}

/** Settings scaled down to a context window; larger configured values stay as upper bounds. */
export function fitMaskingToWindow(
	settings: MaskingSettings,
	contextWindowTokens: number | undefined,
): MaskingSettings {
	if (!contextWindowTokens || contextWindowTokens <= 0) return settings;
	const windowBytes = contextWindowTokens * BYTES_PER_TOKEN;
	return {
		...settings,
		batchBytes: Math.min(settings.batchBytes, Math.floor(windowBytes * BATCH_WINDOW_SHARE)),
		minResultBytes: Math.min(settings.minResultBytes, Math.floor(windowBytes * MIN_RESULT_WINDOW_SHARE)),
	};
}

/**
 * Decide which tool results to elide now. Returns no edits until at least
 * `settings.batchBytes` are eligible, then elides all of them in one batch.
 * With `contextWindowTokens`, thresholds scale to the window and the newest results are kept
 * only while they fit in a quarter of it (at least one is always kept).
 */
export function planMasking(
	entries: readonly ProjectedSessionEntry[],
	configured: MaskingSettings,
	contextWindowTokens?: number,
): MaskingPlan {
	const none: MaskingPlan = { edits: [], elidedBytes: 0 };
	if (!configured.enabled) return none;
	const settings = fitMaskingToWindow(configured, contextWindowTokens);
	const edited = new Set<string>();
	const calls = new Map<string, unknown>();
	const results: Array<{ entryId: string; toolName: string; toolCallId: string; bytes: number; lines: number }> = [];
	for (const { sourceEntry } of entries) {
		if (sourceEntry.type === "context_edit") {
			edited.add(sourceEntry.targetId);
			continue;
		}
		if (sourceEntry.type !== "message") continue;
		const message = sourceEntry.message;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") calls.set(block.id, block.arguments);
			}
		} else if (message.role === "toolResult") {
			results.push({
				entryId: sourceEntry.id,
				toolName: message.toolName,
				toolCallId: message.toolCallId,
				bytes: contentBytes(message.content),
				lines: contentLines(message.content),
			});
		}
	}
	let keep = Math.min(settings.keepRecentResults, results.length);
	if (contextWindowTokens && contextWindowTokens > 0) {
		const keepBudget = contextWindowTokens * BYTES_PER_TOKEN * KEEP_WINDOW_SHARE;
		let kept = 0;
		let keptBytes = 0;
		for (let index = results.length - 1; index >= 0 && kept < keep; index--) {
			const result = results[index];
			if (edited.has(result.entryId) || NEVER_ELIDE.has(result.toolName)) {
				kept++;
				continue;
			}
			if (kept > 0 && keptBytes + result.bytes > keepBudget) break;
			keptBytes += result.bytes;
			kept++;
		}
		keep = kept;
	}
	const eligible = results
		.slice(0, Math.max(0, results.length - keep))
		.filter(
			(result) =>
				!edited.has(result.entryId) && !NEVER_ELIDE.has(result.toolName) && result.bytes >= settings.minResultBytes,
		);
	const eligibleBytes = eligible.reduce((sum, result) => sum + result.bytes, 0);
	if (eligible.length === 0 || eligibleBytes < settings.batchBytes) return none;
	return {
		edits: eligible.map((result) => ({
			type: "context_edit",
			targetId: result.entryId,
			replacement: {
				content: elisionStub(result.toolName, calls.get(result.toolCallId), result.bytes, result.lines),
			},
		})),
		elidedBytes: eligibleBytes,
	};
}
