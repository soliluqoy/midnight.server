import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface SessionFileEdit {
	tool: "edit" | "write";
	diff?: string;
	patch?: string;
	content?: string;
}

export interface SessionFileChange {
	path: string;
	added: number;
	removed: number;
	edits: SessionFileEdit[];
}

export function countPatchLines(patch: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	let inHunk = false;
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) inHunk = false;
		if (line.startsWith("@@ ")) inHunk = true;
		if (!inHunk && (line.startsWith("+++") || line.startsWith("---"))) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

function displayPath(path: string, cwd: string): string {
	const absolute = resolve(cwd, path);
	const rel = relative(cwd, absolute);
	return rel && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel)
		? rel.split(sep).join("/")
		: absolute;
}

export function collectSessionFileChanges(entries: readonly SessionEntry[], cwd: string): SessionFileChange[] {
	const collector = new SessionFileChanges(cwd);
	for (const entry of entries) collector.append(entry);
	return collector.snapshot();
}

export class SessionFileChanges {
	private readonly cwd: string;
	private readonly callPaths = new Map<string, { path: string; tool: "edit" | "write"; content?: string }>();
	private readonly changes = new Map<string, SessionFileChange>();
	private cached: SessionFileChange[] | undefined;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	append(entry: SessionEntry): void {
		const callPaths = this.callPaths;
		const changes = this.changes;
		const cwd = this.cwd;
		if (entry.type !== "message") return;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall" || (block.name !== "edit" && block.name !== "write")) continue;
				const path = block.arguments.path ?? block.arguments.file_path;
				if (typeof path !== "string" || !path) continue;
				const content = block.arguments.content;
				callPaths.set(block.id, { path, tool: block.name, content: typeof content === "string" ? content : undefined });
			}
		} else if (message.role === "toolResult") {
			const call = callPaths.get(message.toolCallId);
			callPaths.delete(message.toolCallId);
			if (!call || message.toolName !== call.tool || message.isError) return;
			const edit: SessionFileEdit = { tool: call.tool };
			let counts = { added: 0, removed: 0 };
			if (call.tool === "edit") {
				const details = message.details as { patch?: unknown; diff?: unknown } | undefined;
				if (typeof details?.patch === "string") edit.patch = details.patch;
				if (typeof details?.diff === "string") edit.diff = details.diff;
				counts = countPatchLines(edit.patch ?? edit.diff ?? "");
			} else if (call.content !== undefined) {
				edit.content = call.content;
				counts = { added: call.content.split("\n").length, removed: 0 };
			}
			const path = displayPath(call.path, cwd);
			const previous = changes.get(path);
			const edits = previous?.edits ?? [];
			edits.push(edit);
			this.cached = undefined;
			changes.delete(path);
			changes.set(path, {
				path,
				added: (previous?.added ?? 0) + counts.added,
				removed: (previous?.removed ?? 0) + counts.removed,
				edits,
			});
		}
	}

	snapshot(): SessionFileChange[] {
		this.cached ??= [...this.changes.values()].reverse();
		return this.cached;
	}
}
