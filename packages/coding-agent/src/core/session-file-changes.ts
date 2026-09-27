import { isAbsolute, relative, resolve } from "node:path";
import type { SessionEntry } from "./session-manager.ts";

export interface SessionFileChange {
	/** Path relative to the session cwd when inside it, otherwise absolute. */
	path: string;
	added: number;
	removed: number;
}

/** Count `+`/`-` body lines of a unified patch, skipping the `+++`/`---` file headers. */
export function countPatchLines(patch: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

function displayPath(path: string, cwd: string): string {
	const absolute = resolve(cwd, path);
	const rel = relative(cwd, absolute);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replace(/\\/g, "/") : absolute;
}

/**
 * Files changed by successful `edit` and `write` tool calls in the session, most recently
 * changed first, with line counts summed across calls. `write` counts every written line as
 * added because the previous content is not recorded.
 */
export function collectSessionFileChanges(entries: readonly SessionEntry[], cwd: string): SessionFileChange[] {
	const callPaths = new Map<string, { path: string; content?: string }>();
	const changes = new Map<string, SessionFileChange>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall" || (block.name !== "edit" && block.name !== "write")) continue;
				const path = block.arguments.path;
				if (typeof path !== "string" || !path) continue;
				const content = block.arguments.content;
				callPaths.set(block.id, { path, content: typeof content === "string" ? content : undefined });
			}
		} else if (message.role === "toolResult" && !message.isError) {
			const call = callPaths.get(message.toolCallId);
			if (!call) continue;
			let counts = { added: 0, removed: 0 };
			if (message.toolName === "edit") {
				const details = message.details as { patch?: unknown } | undefined;
				if (typeof details?.patch === "string") counts = countPatchLines(details.patch);
			} else if (call.content !== undefined) {
				counts = { added: call.content.split("\n").length, removed: 0 };
			}
			const path = displayPath(call.path, cwd);
			const previous = changes.get(path);
			changes.delete(path);
			changes.set(path, {
				path,
				added: (previous?.added ?? 0) + counts.added,
				removed: (previous?.removed ?? 0) + counts.removed,
			});
		}
	}
	return [...changes.values()].reverse();
}
