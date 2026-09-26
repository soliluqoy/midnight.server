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
 */

/** Tools whose results are never elided: they hold state the model must keep seeing. */
const NEVER_ELIDE = new Set(["task"]);

const IMAGE_BYTES = 50_000;

function contentBytes(content: readonly (TextContent | ImageContent)[]): number {
	let bytes = 0;
	for (const part of content) bytes += part.type === "text" ? Buffer.byteLength(part.text) : IMAGE_BYTES;
	return bytes;
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

export function elisionStub(toolName: string, args: unknown, bytes: number): string {
	const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} bytes`;
	const shown = compactArgs(args);
	return `[${toolName}${shown ? ` ${shown}` : ""} output elided by the harness to save context (${size}). Call the tool again if you need this content.]`;
}

export interface MaskingPlan {
	edits: ContextEditEntryDraft[];
	elidedBytes: number;
}

/**
 * Decide which tool results to elide now. Returns no edits until at least
 * `settings.batchBytes` are eligible, then elides all of them in one batch.
 */
export function planMasking(entries: readonly ProjectedSessionEntry[], settings: MaskingSettings): MaskingPlan {
	const none: MaskingPlan = { edits: [], elidedBytes: 0 };
	if (!settings.enabled) return none;
	const edited = new Set<string>();
	const calls = new Map<string, unknown>();
	const results: Array<{ entryId: string; toolName: string; toolCallId: string; bytes: number }> = [];
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
			});
		}
	}
	const eligible = results
		.slice(0, Math.max(0, results.length - settings.keepRecentResults))
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
			replacement: { content: elisionStub(result.toolName, calls.get(result.toolCallId), result.bytes) },
		})),
		elidedBytes: eligibleBytes,
	};
}
