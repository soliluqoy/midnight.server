import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { protectedLogLines } from "../triage/analysis.ts";
import { type TrimEngine, TrimRuntime } from "../trim/runtime.ts";
import type { LiveContextMessage } from "./types.ts";

function plainText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text") return undefined;
	return typeof content[0].text === "string" ? content[0].text : undefined;
}

function eligible(name: unknown, args: unknown): boolean {
	if (!args || typeof args !== "object") return false;
	const input = args as Record<string, unknown>;
	if (name === "read") {
		if (input.offset != null || input.limit != null || typeof input.path !== "string") return false;
		const file = basename(input.path.replaceAll("\\", "/"));
		if (/agents|instructions|skill|claude|prompt|live_context|credentials|secret/i.test(file)) return false;
		const ext = extname(file).toLowerCase();
		return (
			ext === ".log" || ext === ".out" || (ext === ".txt" && /^(?:build|test|lint|check|compiler|ci)[._-]/i.test(file))
		);
	}
	return (
		name === "bash" &&
		typeof input.command === "string" &&
		/^(?:npm (?:test|run (?:check|test|build|lint))|pnpm (?:test|build|lint)|cargo (?:test|check|build)|go test \.\/\.\.\.)\s*$/.test(
			input.command,
		)
	);
}

function renderSelection(lines: string[], indices: number[]): string {
	const selected = new Set(indices);
	const output: string[] = [];
	let omitted = 0;
	for (let index = 0; index < lines.length; index++) {
		if (!selected.has(index)) {
			omitted++;
			continue;
		}
		if (omitted) output.push(`… ${omitted} lines …`);
		omitted = 0;
		output.push(lines[index]);
	}
	if (omitted) output.push(`… ${omitted} lines …`);
	return output.join("\n");
}

interface Decision {
	indices?: number[];
	snapshot?: string;
}

export class ContextTrimmer {
	private controller = new AbortController();
	private decisions = new Map<string, Decision>();
	private snapshotBytes = 0;
	private readonly engine: TrimEngine;
	constructor(engine: TrimEngine = new TrimRuntime()) {
		this.engine = engine;
	}

	reset(): void {
		this.controller.abort();
		this.controller = new AbortController();
		this.engine.reset();
		this.decisions.clear();
		this.snapshotBytes = 0;
	}

	async apply(
		messages: LiveContextMessage[],
		directory: string,
		protectBefore = 0,
		signal?: AbortSignal,
	): Promise<LiveContextMessage[]> {
		const lifecycle = this.controller;
		const combined = AbortSignal.any([lifecycle.signal, ...(signal ? [signal] : [])]);
		const calls = new Map<string, { name: unknown; args: unknown }>();
		let query = "";
		let attempts = 0;
		const output = [...messages];
		for (let position = 0; position < messages.length; position++) {
			if (combined.aborted) return messages;
			const message = messages[position];
			if (message.role === "user") query = plainText(message.content) ?? "";
			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const part of message.content) {
					if (part?.type === "toolCall" && typeof part.id === "string")
						calls.set(part.id, { name: part.name, args: part.arguments });
				}
			}
			if (
				message.role !== "toolResult" ||
				position < protectBefore ||
				message.structuredContent !== undefined ||
				message.nestedCalls !== undefined
			)
				continue;
			const call = calls.get(String(message.toolCallId));
			if (!call || call.name !== message.toolName || !eligible(call.name, call.args) || !query.trim()) continue;
			const text = plainText(message.content);
			if (
				!text ||
				text.length < 4000 ||
				/\[Midnight Trim-1|\[pi-clm|Showing (?:lines|last)|output truncated/i.test(text)
			)
				continue;
			if (/^\s*[[{<]/u.test(text) || /^```/mu.test(text)) continue;
			const bytes = Buffer.byteLength(text);
			if (bytes > 1024 * 1024) continue;
			const hash = createHash("sha256").update(text).digest("hex");
			const key = `${String(message.toolCallId)}:${hash}`;
			let decision = this.decisions.get(key);
			const lines = text.split("\n");
			if (!decision) {
				if (attempts >= 4 || this.decisions.size >= 128 || this.snapshotBytes + bytes > 16 * 1024 * 1024) continue;
				attempts++;
				const result = await this.engine.run(text, query, "trim", combined);
				if (combined.aborted) return messages;
				decision = {};
				if (result.kept) {
					const keep = protectedLogLines(lines.map(stripVTControlCharacters));
					for (const index of result.kept) keep.add(index);
					const indices = [...keep].sort((a, b) => a - b);
					const snapshot = join(directory, "trim", `${hash}.txt`);
					const candidate = this.content(lines, indices, snapshot, hash);
					if (Buffer.byteLength(candidate) <= bytes * 0.9) {
						try {
							await mkdir(join(directory, "trim"), { recursive: true, mode: 0o700 });
							await writeFile(snapshot, text, { mode: 0o600, signal: combined });
							if (combined.aborted) return messages;
							decision = { indices, snapshot };
							this.snapshotBytes += bytes;
						} catch {
							if (combined.aborted) return messages;
						}
					}
				}
				this.decisions.set(key, decision);
			}
			if (decision.indices && decision.snapshot) {
				output[position] = {
					...message,
					content: [{ type: "text", text: this.content(lines, decision.indices, decision.snapshot, hash) }],
				};
			}
		}
		return output;
	}

	private content(lines: string[], indices: number[], snapshot: string, hash: string): string {
		return `[Midnight Trim-1: query-selected excerpt, not complete evidence. Exact retained lines in source order; gaps are marked. Full temporary tool output (may contain secrets): ${snapshot}. SHA-256: ${hash}. Original also remains in session history. Read the snapshot with offset/limit for omitted context.]\n${renderSelection(lines, indices)}`;
	}
}
