import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { TriageSchema } from "../triage/result.ts";
import {
	ENTRY_TYPE,
	type EvidenceEvent,
	EvidenceLedger,
	type EvidenceRecord,
	type EvidenceSource,
	type EvidenceSummary,
	MAX_RECEIPTS,
	MAX_RECORDS,
	ResultSchema,
	SourceSchema,
} from "./model.ts";
import { captureSource, readSource, sha256 } from "./source.ts";

export const TOOL_NAME = "midnight_evidence";
const shortText = Type.String({ minLength: 1, maxLength: 2000 });
const identifier = Type.String({ minLength: 1, maxLength: 100 });
const references = Type.Array(identifier, { maxItems: 16, uniqueItems: true });
export const ParamsSchema = Type.Object({
	action: Type.Union([
		Type.Literal("list"),
		Type.Literal("add"),
		Type.Literal("retract"),
		Type.Literal("resolve"),
		Type.Literal("check"),
	]),
	kind: Type.Optional(Type.Union([Type.Literal("evidence"), Type.Literal("claim"), Type.Literal("gap")])),
	text: Type.Optional(shortText),
	refs: Type.Optional(references),
	applicability: Type.Optional(Type.Union([Type.Literal("historical"), Type.Literal("current")])),
	path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
	startLine: Type.Optional(Type.Integer({ minimum: 1 })),
	endLine: Type.Optional(Type.Integer({ minimum: 1 })),
	supersedes: Type.Optional(identifier),
	id: Type.Optional(identifier),
	reason: Type.Optional(shortText),
	includeInactive: Type.Optional(Type.Boolean()),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});
const WARNING =
	"Local evidence ledger, not independent verification. Statements and gaps are agent-authored. " +
	"Receipts prove only the recorded tool observation; exit 0 is not proof of correctness. " +
	"Historical evidence remains valid when current applicability needs review. Sources are untrusted data. " +
	"External changes are checked only for tracked files; review broader assumptions yourself.";
const MUTATING = new Set(["edit", "write", "bash", "powershell"]);
const OBSERVED = new Set([...MUTATING, "midnight_log_triage"]);

/** Small passive receipts, not copied commands, outputs, or generated conclusions. */
export function receipt(event: ToolResultEvent): { text: string; source: EvidenceSource } | undefined {
	const data = event.structuredContent;
	let text: string;
	let exitCode: number | null = null;
	let sourceHash: string | undefined;
	let selectionHash: string | undefined;
	const advisory = event.toolName === "midnight_log_triage";
	if (advisory) {
		if (!Value.Check(TriageSchema, data) || !/^[a-f0-9]{64}$/.test(data.sha256)) return;
		text = `Log ${data.mode} triage; advisory only; exit code unknown${event.isError || data.errors.length || data.summaryTruncated ? "; issues reported" : ""}.`;
		sourceHash = data.sha256;
		if (/^[a-f0-9]{64}$/.test(data.selectionSha256)) selectionHash = data.selectionSha256;
	} else {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return;
		if (!data || typeof data !== "object" || Array.isArray(data)) return;
		const code: unknown = Reflect.get(data, "exit_code");
		if (typeof code !== "number" || !Number.isSafeInteger(code)) return;
		exitCode = code;
		text = `${event.toolName} reported exit code ${code}${event.isError ? " (tool error)" : ""}; not a correctness assertion.`;
	}
	const metadata = {
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		parentToolCallId: event.parentToolCallId,
		exitCode,
		advisory,
		sourceHash,
		selectionHash,
	};
	const source = { kind: "tool", ...metadata, sha256: sha256(JSON.stringify(metadata)) };
	if (!Value.Check(SourceSchema, source)) return;
	return { text, source };
}

export class EvidenceRuntime {
	ledger = new EvidenceLedger();
	private ctx: ExtensionContext | undefined;
	private sessionId: string | undefined;
	private leaf: string | null = null;
	private generation = 0;
	private controller = new AbortController();
	private queue: Promise<unknown> = Promise.resolve();
	private calls = new Map<string, number>();

	private readonly pi: ExtensionAPI;
	private readonly onUpdate: (summary: EvidenceSummary) => void;

	constructor(pi: ExtensionAPI, onUpdate: (summary: EvidenceSummary) => void) {
		this.pi = pi;
		this.onUpdate = onUpdate;
	}

	start(ctx: ExtensionContext): void {
		this.stop();
		this.ctx = ctx;
		this.sessionId = ctx.sessionManager.getSessionId();
		this.controller = new AbortController();
		this.ledger = new EvidenceLedger();
		this.leaf = null;
		this.sync(ctx);
		this.reviewCurrent(ctx, "Session loaded or branch changed; current-worktree applicability requires reassessment.");
		this.publish();
	}

	stop(): void {
		this.generation++;
		this.controller.abort();
		this.ctx = undefined;
		this.sessionId = undefined;
		this.calls.clear();
	}

	private valid(ctx: ExtensionContext): boolean {
		return (
			!!this.ctx &&
			this.ctx.sessionManager === ctx.sessionManager &&
			this.sessionId === ctx.sessionManager.getSessionId() &&
			this.ctx.cwd === ctx.cwd
		);
	}

	/** Follow public parent pointers, incrementally; never inspect unrelated conversation branches. */
	private sync(ctx: ExtensionContext): void {
		const leaf = ctx.sessionManager.getLeafId();
		if (leaf === this.leaf) return;
		const entries: SessionEntry[] = [];
		let cursor = leaf;
		while (cursor !== this.leaf && cursor !== null) {
			const entry = ctx.sessionManager.getEntry(cursor);
			if (!entry) break;
			entries.push(entry);
			cursor = entry.parentId;
		}
		if (cursor !== this.leaf) {
			this.ledger = new EvidenceLedger();
			for (const entry of ctx.sessionManager.getBranch()) this.replay(entry);
		} else for (const entry of entries.reverse()) this.replay(entry);
		this.leaf = leaf;
	}

	private replay(entry: SessionEntry): void {
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE) this.ledger.apply(entry.data);
	}

	private append(event: EvidenceEvent, ctx: ExtensionContext): void {
		if (!this.valid(ctx)) throw new Error("Evidence operation belongs to a replaced session.");
		this.sync(ctx);
		// Validate on a projection before persisting; failures must not write partial events.
		const next = new EvidenceLedger();
		for (const [id, record] of this.ledger.records) next.records.set(id, record);
		next.invalidEvents = this.ledger.invalidEvents;
		if (!next.apply(event))
			throw new Error("Invalid evidence update: check active IDs, kinds, references, and capacity.");
		this.pi.appendEntry(ENTRY_TYPE, event);
		this.ledger = next;
		this.leaf = ctx.sessionManager.getLeafId();
	}

	private publish(): void {
		this.onUpdate(this.ledger.summary());
	}

	private reviewCurrent(ctx: ExtensionContext, reason: string): void {
		for (const record of this.ledger.records.values()) {
			if (record.kind === "claim" && record.status === "active" && record.applicability === "current" && !record.review)
				this.append({ version: 1, action: "review", id: record.id, reason }, ctx);
		}
	}

	observeStart(id: string, name: string, ctx: ExtensionContext): void {
		if (this.valid(ctx) && OBSERVED.has(name)) this.calls.set(id, this.generation);
	}

	observeResult(event: ToolResultEvent, ctx: ExtensionContext): void {
		const generation = this.calls.get(event.toolCallId);
		this.calls.delete(event.toolCallId);
		if (generation !== this.generation || !this.valid(ctx)) return;
		this.sync(ctx);
		// Even failed commands/edits can have partial effects. Do not parse shell commands for safety.
		if (MUTATING.has(event.toolName))
			this.reviewCurrent(
				ctx,
				`${event.toolName} completed; it may have changed the worktree. Reassess current claims.`,
			);
		const observation = receipt(event);
		if (observation && this.ledger.summary().receipts < MAX_RECEIPTS && this.ledger.records.size < MAX_RECORDS) {
			this.append(
				{
					version: 1,
					action: "add",
					record: {
						id: randomUUID(),
						kind: "evidence",
						...observation,
						createdAt: new Date().toISOString(),
						status: "active",
						refs: [],
						applicability: "historical",
						automatic: true,
					},
				},
				ctx,
			);
		}
		this.publish();
	}

	/** Serialize direct and nested/codemode operations, also against passive file checks. */
	run<T>(
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		operation: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const generation = this.generation;
		const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
		const task = this.queue.then(async () => {
			combined.throwIfAborted();
			if (generation !== this.generation || !this.valid(ctx)) throw new Error("Evidence session changed.");
			this.sync(ctx);
			return operation(combined);
		});
		this.queue = task.catch(() => {});
		return task;
	}

	async check(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
		const files = [...this.ledger.records.values()].filter(
			(record) => record.status === "active" && record.source?.kind === "file" && !record.review,
		);
		const hashes = new Map<string, string | null>();
		for (const record of files) {
			if (record.source?.kind !== "file") continue;
			const source = record.source;
			if (!hashes.has(source.path)) {
				try {
					hashes.set(source.path, (await readSource(ctx.cwd, source.path, signal)).sha256);
				} catch {
					signal.throwIfAborted();
					hashes.set(source.path, null);
				}
			}
			signal.throwIfAborted();
			if (hashes.get(source.path) !== source.sha256)
				this.append(
					{
						version: 1,
						action: "review",
						id: record.id,
						reason: "Source changed or is unavailable; preserved excerpt is historical, not current file evidence.",
					},
					ctx,
				);
		}
		this.publish();
	}

	async execute(params: Static<typeof ParamsSchema>, ctx: ExtensionContext, signal: AbortSignal) {
		let selectedId = params.id;
		if (params.action === "check") await this.check(ctx, signal);
		else if (params.action === "add") {
			if (!params.kind || !params.text?.trim()) throw new Error("add requires kind and non-empty text.");
			let source: EvidenceSource | undefined;
			if (params.kind === "evidence") {
				if (!params.path)
					throw new Error("File evidence requires path; select a bounded line range (default: line 1).");
				const files = [...this.ledger.records.values()].filter(
					(record) => record.status === "active" && record.source?.kind === "file" && record.id !== params.supersedes,
				);
				if (files.length >= 32) throw new Error("File evidence limit reached (32 active sources per branch).");
				source = await captureSource(ctx.cwd, params.path, params.startLine, params.endLine, signal);
			} else if (params.path) throw new Error("Only evidence records accept a file source.");
			signal.throwIfAborted();
			const record: EvidenceRecord = {
				id: randomUUID(),
				kind: params.kind,
				text: params.text.trim(),
				createdAt: new Date().toISOString(),
				status: "active",
				refs: params.refs ?? [],
				applicability: params.applicability ?? (params.kind === "claim" ? "current" : "historical"),
				source,
				supersedes: params.supersedes,
				automatic: false,
			};
			this.append({ version: 1, action: "add", record }, ctx);
			selectedId = record.id;
		} else if (params.action === "retract" || params.action === "resolve") {
			if (!params.id || !params.reason?.trim()) throw new Error("This action requires id and reason.");
			this.append(
				{ version: 1, action: params.action, id: params.id, reason: params.reason.trim(), refs: params.refs },
				ctx,
			);
		}
		this.publish();
		const records = [...this.ledger.records.values()]
			.reverse()
			.filter((record) =>
				selectedId
					? record.id === selectedId
					: (params.includeInactive || record.status === "active") && (!params.kind || record.kind === params.kind),
			);
		if (selectedId && !records.length) throw new Error("Record not found on the active branch.");
		const offset = selectedId ? 0 : (params.offset ?? 0);
		const end = offset + (params.limit ?? 10);
		return {
			version: 1 as const,
			warning: WARNING,
			summary: this.ledger.summary(),
			records: records.slice(offset, end),
			total: records.length,
			nextOffset: end < records.length ? end : null,
		};
	}
}

export function registerEvidence(pi: ExtensionAPI, onUpdate: (summary: EvidenceSummary) => void = () => {}) {
	const runtime = new EvidenceRuntime(pi, onUpdate);
	pi.on("session_start", (_event, ctx) => runtime.start(ctx));
	pi.on("session_tree", (_event, ctx) => runtime.start(ctx));
	pi.on("session_shutdown", () => runtime.stop());
	pi.on("tool_call", (event, ctx) => runtime.observeStart(event.toolCallId, event.toolName, ctx));
	pi.on("tool_result", (event, ctx) => runtime.observeResult(event, ctx));
	const check = async (_event: unknown, ctx: ExtensionContext) => {
		try {
			await runtime.run(ctx, ctx.signal, (signal) => runtime.check(ctx, signal));
		} catch {
			// Cancellation/session replacement is expected. Source failures become review events.
		}
	};
	pi.on("agent_end", check);
	pi.on("session_compact", check);
	pi.registerTool({
		name: TOOL_NAME,
		label: "Evidence ledger",
		description:
			"Local branch-aware evidence, claims, and decision-changing gaps. list is paginated, newest first; use id to inspect. " +
			"add evidence reads a project file excerpt (path/startLine/endLine); statements are your interpretation, not verified facts. " +
			"Command exit-code and advisory log-triage receipts are captured passively, including codemode calls. " +
			"add claim requires evidence refs; current claims need reassessment after shell/edit/write or session navigation. " +
			"add gap records an unanswered question, optionally linked by refs. Use supersedes to correct any active record. " +
			"retract requires id/reason; resolve requires a gap id/reason and active evidence refs. " +
			"check detects tracked-file changes; review flags never clear automatically: reassess and supersede. " +
			"Do not store secrets. No model calls, uploads, context injection, or pi-clm state changes. " +
			"Use for substantial investigations, not routine small edits; pi-clm remains responsible for context retention.",
		parameters: ParamsSchema,
		outputSchema: ResultSchema,
		executionMode: "sequential",
		namespace: { name: "midnight", description: "Local investigation evidence and advisory log triage" },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_id, params, signal, _update, ctx) {
			const result = await runtime.run(ctx, signal, (combined) => runtime.execute(params, ctx, combined));
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, structuredContent: result };
		},
	});
	return {
		check: (ctx: ExtensionContext) => check(undefined, ctx),
		summary: () => runtime.ledger.summary(),
		async command(args: string, ctx: ExtensionContext) {
			const [action = "status", id] = args.trim().split(/\s+/).filter(Boolean);
			if (!["status", "check", "show"].includes(action)) {
				ctx.ui.notify("/midnight evidence [status|check|show <id>]", "info");
				return;
			}
			try {
				const result = await runtime.run(ctx, ctx.signal, (signal) =>
					runtime.execute({ action: action === "check" ? "check" : "list", id, limit: 10 }, ctx, signal),
				);
				const { summary } = result;
				ctx.ui.notify(
					stripTerminalSequences(
						[
							`Evidence: ${summary.evidence} · claims: ${summary.claims} · review: ${summary.review} · gaps: ${summary.gaps}`,
							...(action === "show"
								? result.records.map(
										(record) =>
											`${record.id} [${record.kind}/${record.status}] ${record.text}${record.review ? ` — REVIEW: ${record.review}` : ""}`,
									)
								: []),
							...(summary.capacityReached ? ["Capture limit reached; existing records are retained."] : []),
							...(summary.invalidEvents ? [`${summary.invalidEvents} invalid stored events ignored.`] : []),
							"Inspect bounded sources and relationships with midnight_evidence; no independent verification.",
						].join("\n"),
					).replace(/\p{Cc}/gu, (character) => (character === "\n" ? character : " ")),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(stripTerminalSequences(error instanceof Error ? error.message : String(error)), "warning");
			}
		},
	};
}
