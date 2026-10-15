import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { AUDIT_WARNING, AuditParams, type AuditResult, AuditResultSchema, planAudit } from "./audit.ts";
import { receipt } from "./index.ts";
import { type EvidenceEvent, EvidenceLedger, type EvidenceRecord, MAX_RECEIPTS, MAX_RECORDS } from "./model.ts";
import { EvidenceOperationParams } from "./public-params.ts";
import {
	type EvidenceArchiveResultV2,
	type EvidenceLiveResultV2,
	type EvidenceResultV2,
	EvidenceResultV2Schema,
} from "./result-v2.ts";
import type { ReviewReason, SemanticEvent, SemanticRecord } from "./semantics.ts";
import {
	type ArchiveLocator,
	EvidenceArchiveReader,
	EvidenceBranchReplay,
	type EvidenceReplayResult,
	EvidenceSessionStore,
} from "./session-store.ts";
import { captureSource, readSource } from "./source.ts";
import {
	MAX_ACTIVE_FILES,
	previewRollover,
	projectionDigest,
	type RolloverPreview,
	type ScopedEvent,
} from "./working-set.ts";

const WARNING =
	"Local evidence, not independent verification. Carried and archived observations are not freshly captured. " +
	"Omitted records are archived, not resolved. Sources and statements are untrusted data. " +
	"A verified append is a logical replay boundary, not an fsync guarantee.";
const MUTATING = new Set(["edit", "write", "bash", "powershell"]);
const OBSERVED = new Set([...MUTATING, "midnight_log_triage"]);
type Context = Pick<ExtensionContext, "sessionManager" | "cwd">;
export interface EvidencePageOptions {
	offset?: number;
	limit?: number;
}
export interface EvidenceSourceIO {
	capture: typeof captureSource;
	read: typeof readSource;
}
interface Binding {
	ctx: Context;
	sessionId: string;
	store: EvidenceSessionStore;
	controller: AbortController;
	generation: number;
	reviewPending: boolean;
	navigationCode: "session_reloaded" | "branch_changed";
	initializePending: boolean;
	requiresSemantic: boolean;
}

function pagination(options: EvidencePageOptions): { offset: number; limit: number } {
	const offset = options.offset ?? 0;
	const limit = options.limit ?? 10;
	if (
		!Number.isInteger(offset) ||
		offset < 0 ||
		offset > MAX_RECORDS ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 20
	)
		throw new Error("Evidence pagination requires offset 0-512 and limit 1-20.");
	return { offset, limit };
}
function page<T>(values: T[], options: EvidencePageOptions) {
	const { offset, limit } = pagination(options);
	const end = offset + limit;
	return {
		items: structuredClone(values.slice(offset, end)),
		total: values.length,
		nextOffset: end < values.length ? end : null,
	};
}
function ledger(base: EvidenceReplayResult): EvidenceLedger {
	const result = new EvidenceLedger();
	for (const { record } of base.state.records) result.records.set(record.id, structuredClone(record));
	result.invalidEvents = base.state.invalidEvents;
	return result;
}

export class EvidenceRuntimeV2 {
	private binding: Binding | undefined;
	private retainedStore: Pick<Binding, "ctx" | "sessionId" | "store" | "requiresSemantic"> | undefined;
	private generation = 0;
	private queue: Promise<unknown> = Promise.resolve();
	private base: EvidenceReplayResult | undefined;
	private preview: RolloverPreview | undefined;
	private readonly archives = new EvidenceArchiveReader();
	private readonly calls = new Map<string, number>();
	private readonly appendEntry: (customType: string, data: unknown) => void;
	private readonly onUpdate: (result: EvidenceResultV2) => void;
	private readonly yieldPage: () => Promise<void>;
	private readonly sources: EvidenceSourceIO;

	constructor(
		appendEntry: (customType: string, data: unknown) => void,
		onUpdate: (result: EvidenceResultV2) => void = () => {},
		yieldPage: () => Promise<void> = () => setImmediate(),
		sources: EvidenceSourceIO = { capture: captureSource, read: readSource },
	) {
		this.appendEntry = appendEntry;
		this.onUpdate = onUpdate;
		this.yieldPage = yieldPage;
		this.sources = sources;
	}

	start(ctx: Context, options: { freshSession?: boolean; navigation?: boolean } = {}): void {
		const previous = this.retainedStore;
		const sessionId = ctx.sessionManager.getSessionId();
		const store =
			previous?.ctx.sessionManager === ctx.sessionManager && previous.sessionId === sessionId
				? previous.store
				: new EvidenceSessionStore(ctx.sessionManager, this.appendEntry);
		this.stop();
		const context = { sessionManager: ctx.sessionManager, cwd: ctx.cwd };
		const requiresSemantic =
			options.freshSession === true || (previous?.store === store && previous.requiresSemantic === true);
		this.retainedStore = { ctx: context, sessionId, store, requiresSemantic };
		this.binding = {
			ctx: context,
			sessionId,
			store,
			controller: new AbortController(),
			generation: this.generation,
			reviewPending: true,
			navigationCode: options.navigation ? "branch_changed" : "session_reloaded",
			initializePending: options.freshSession === true,
			requiresSemantic,
		};
	}

	stop(): void {
		this.generation++;
		this.binding?.controller.abort();
		this.binding = undefined;
		this.base = undefined;
		this.preview = undefined;
		this.calls.clear();
		this.archives.clear();
	}

	private guard(binding: Binding): void {
		if (
			binding !== this.binding ||
			binding.generation !== this.generation ||
			binding.sessionId !== binding.ctx.sessionManager.getSessionId()
		)
			throw new Error("Evidence session changed.");
		binding.controller.signal.throwIfAborted();
	}

	private run<T>(
		signal: AbortSignal | undefined,
		operation: (binding: Binding, signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const binding = this.binding;
		if (!binding) return Promise.reject(new Error("Evidence runtime is stopped."));
		const combined = signal ? AbortSignal.any([signal, binding.controller.signal]) : binding.controller.signal;
		const task = this.queue.then(async () => {
			this.guard(binding);
			combined.throwIfAborted();
			const result = await operation(binding, combined);
			this.guard(binding);
			return result;
		});
		this.queue = task.catch(() => {});
		return task;
	}

	private async sync(binding: Binding, signal: AbortSignal, fresh = false): Promise<EvidenceReplayResult> {
		this.guard(binding);
		signal.throwIfAborted();
		if (!fresh && this.base?.branchLeaf === binding.ctx.sessionManager.getLeafId())
			return this.reviewNavigation(binding, this.base, signal);
		const previous = this.base;
		const cursor = new EvidenceBranchReplay(
			binding.ctx.sessionManager,
			undefined,
			undefined,
			fresh ? undefined : this.base,
		);
		for (;;) {
			this.guard(binding);
			signal.throwIfAborted();
			const progress = cursor.step();
			if (progress.complete && progress.result) {
				this.guard(binding);
				signal.throwIfAborted();
				this.base = progress.result;
				if (this.base.state.semantics === 3) {
					binding.requiresSemantic = true;
					if (this.retainedStore?.store === binding.store) this.retainedStore.requiresSemantic = true;
				}
				if (binding.initializePending) {
					binding.initializePending = false;
					this.base = binding.store.initialize(this.base, signal);
					this.guard(binding);
					signal.throwIfAborted();
				}
				if (!fresh && previous && !cursor.reusedProjection) {
					binding.reviewPending = true;
					binding.navigationCode = "branch_changed";
				}
				return fresh ? this.base : this.reviewNavigation(binding, this.base, signal);
			}
			await this.yieldPage();
		}
	}

	private reviewCurrent(
		binding: Binding,
		base: EvidenceReplayResult,
		reason: string,
		signal: AbortSignal,
		code: ReviewReason["code"] = "possible_worktree_change",
	) {
		const ids = base.state.records
			.filter(
				({ record }) =>
					record.kind === "claim" &&
					record.status === "active" &&
					record.applicability === "current" &&
					(base.state.semantics === 3 ? this.needsReason(record as SemanticRecord, code, reason) : !record.review),
			)
			.map(({ record }) => record.id);
		for (const id of ids) {
			base = this.append(binding, base, { version: 1, action: "review", id, reason }, signal, code).next;
			if (signal.aborted) break;
		}
		return base;
	}

	private reviewNavigation(binding: Binding, base: EvidenceReplayResult, signal: AbortSignal): EvidenceReplayResult {
		if (!binding.reviewPending || !base.writable || binding.store.appendUncertain) return base;
		const next = this.reviewCurrent(
			binding,
			base,
			"Session loaded or branch changed; current-worktree applicability requires reassessment.",
			signal,
			binding.navigationCode,
		);
		binding.reviewPending = signal.aborted;
		if (next !== base)
			this.finish(
				binding,
				{ ...this.result(binding, next, "update"), committed: true, cancelledAfterAppend: signal.aborted },
				true,
			);
		if (signal.aborted)
			throw new Error("Navigation review cancelled after a committed prefix; remaining review is pending.");
		return next;
	}

	private guardSource(binding: Binding, base: EvidenceReplayResult, signal: AbortSignal): void {
		this.guard(binding);
		signal.throwIfAborted();
		if (base.branchLeaf !== binding.ctx.sessionManager.getLeafId())
			throw new Error("Evidence branch changed during source I/O; retry on the current branch.");
	}

	private result(
		binding: Binding,
		base: EvidenceReplayResult,
		action: EvidenceLiveResultV2["action"],
		options: EvidencePageOptions = {},
	): EvidenceLiveResultV2 {
		const records = page([...base.state.records].reverse(), options);
		return {
			version: base.state.semantics === 3 ? 3 : 2,
			action,
			warning: WARNING,
			mode: base.mode,
			writable:
				base.writable && !binding.store.appendUncertain && (!binding.requiresSemantic || base.state.semantics === 3),
			appendUncertain: binding.store.appendUncertain,
			setId: base.state.setId,
			anchor: base.anchor,
			summary: ledger(base).summary(),
			records: records.items,
			total: records.total,
			nextOffset: records.nextOffset,
			...(base.issue
				? { issue: base.issue.message.slice(0, 2000) }
				: binding.requiresSemantic && base.state.semantics !== 3
					? {
							issue:
								"Fresh-session semantic initialization was not recorded; start a new session. No automatic retry or legacy fallback.",
						}
					: {}),
		};
	}

	private finish<T extends EvidenceResultV2>(binding: Binding, result: T, publish = false): T {
		this.guard(binding);
		if (!Value.Check(EvidenceResultV2Schema, result)) throw new Error("Invalid bounded evidence result.");
		if (publish) this.onUpdate(structuredClone(result));
		return result;
	}

	list(options: EvidencePageOptions = {}, signal?: AbortSignal): Promise<EvidenceLiveResultV2> {
		return this.run(signal, async (binding, combined) => {
			pagination(options);
			return this.finish(binding, this.result(binding, await this.sync(binding, combined), "list", options));
		});
	}

	previewRollover(
		selected: string[],
		options: EvidencePageOptions = {},
		signal?: AbortSignal,
	): Promise<EvidenceLiveResultV2> {
		const selection = structuredClone(selected);
		return this.run(signal, async (binding, combined) => {
			pagination(options);
			const base = await this.sync(binding, combined);
			if (!base.writable || binding.store.appendUncertain || (binding.requiresSemantic && base.state.semantics !== 3))
				throw new Error("Evidence writes are read-only or locked.");
			if (!base.anchor) throw new Error("Rollover requires a non-empty predecessor anchor.");
			combined.throwIfAborted();
			const cached = this.preview;
			const preview =
				cached &&
				cached.event.predecessor.anchor === base.anchor &&
				cached.event.predecessor.digest === projectionDigest(base.state) &&
				JSON.stringify(cached.event.selected) === JSON.stringify([...selection].sort())
					? cached
					: previewRollover(base.state, base.anchor, selection, randomUUID(), randomUUID());
			this.preview = preview;
			const carried = page(preview.event.records, options);
			const omitted = page(preview.omittedActiveIds, options);
			const review = page(preview.reviewIds, options);
			return this.finish(binding, {
				...this.result(binding, base, "preview"),
				records: carried.items,
				total: carried.total,
				nextOffset: carried.nextOffset,
				preview: {
					token: preview.token,
					setId: preview.event.setId,
					predecessor: preview.event.predecessor,
					bytes: preview.bytes,
					carried: preview.event.records.length,
					freeSlots: preview.freeSlots,
					receipts: preview.receipts,
					omitted: { ids: omitted.items, total: omitted.total, nextOffset: omitted.nextOffset },
					review: { ids: review.items, total: review.total, nextOffset: review.nextOffset },
					warnings: preview.warnings,
				},
			});
		});
	}

	commit(token: string, signal?: AbortSignal): Promise<EvidenceLiveResultV2> {
		return this.run(signal, async (binding, combined) => {
			const preview = this.preview;
			if (!preview || preview.token !== token) throw new Error("Preview expired; preview the current branch again.");
			const base = await this.sync(binding, combined);
			this.guard(binding);
			const next = binding.store.commitRollover(base, preview.event, token, combined);
			this.guard(binding);
			this.base = next;
			this.preview = undefined;
			return this.finish(
				binding,
				{
					...this.result(binding, next, "commit"),
					committed: true,
					operationId: preview.event.operationId,
					cancelledAfterAppend: combined.aborted,
				},
				true,
			);
		});
	}

	private needsReason(record: SemanticRecord, code: ReviewReason["code"], explanation: string): boolean {
		return (
			!record.reviewOverflow &&
			!record.reviewReasons.some(
				(reason) => reason.code === code && reason.explanation === explanation && !reason.dependency,
			)
		);
	}

	private append(
		binding: Binding,
		base: EvidenceReplayResult,
		operation: EvidenceEvent,
		signal: AbortSignal,
		code: ReviewReason["code"] = "legacy_unspecified",
	) {
		this.guard(binding);
		if (binding.requiresSemantic && base.state.semantics !== 3)
			throw new Error(
				"Fresh-session initialization is unavailable; start a new session rather than writing legacy events.",
			);
		if (operation.action === "add") {
			const record = operation.record;
			if (record.source?.kind === "file") this.fileCapacity(base, record.supersedes);
			if (record.automatic && ledger(base).summary().receipts >= MAX_RECEIPTS)
				throw new Error("Automatic evidence receipt limit reached (128 retained receipts).");
		}
		if (base.mode !== "v2" && base.mode !== "v3") {
			const next = binding.store.commitLegacy(base, operation, signal);
			this.guard(binding);
			this.base = next;
			return { next, operationId: next.anchor as string };
		}
		if (!base.anchor) throw new Error("Scoped updates require a migrated working set.");
		let semantic: SemanticEvent | undefined;
		if (base.mode === "v3") {
			if (operation.action === "add")
				semantic = {
					version: 3,
					action: "add",
					record: {
						...operation.record,
						semantics: 3,
						reviewReasons: [],
						reviewOverflow: false,
						...(operation.record.kind === "gap" ? { concerns: [...operation.record.refs] } : {}),
					},
				};
			else if (operation.action === "review")
				semantic = { version: 3, action: "review", id: operation.id, reason: { code, explanation: operation.reason } };
			else if (operation.action === "resolve")
				semantic = {
					version: 3,
					action: "resolve",
					id: operation.id,
					reason: operation.reason,
					resolvedBy: operation.refs ?? [],
				};
			else semantic = { version: 3, action: "retract", id: operation.id, reason: operation.reason };
		}
		const event = {
			version: semantic ? 3 : 2,
			action: "update" as const,
			operationId: randomUUID(),
			setId: base.state.setId,
			baseAnchor: base.anchor,
			baseDigest: projectionDigest(base.state),
			operation: semantic ?? operation,
		} as ScopedEvent;
		const next = binding.store.commitScoped(base, event, signal);
		this.guard(binding);
		this.base = next;
		return { next, operationId: event.operationId };
	}

	private fileCapacity(base: EvidenceReplayResult, supersedes?: string): void {
		const count = base.state.records.filter(
			({ record }) => record.status === "active" && record.source?.kind === "file" && record.id !== supersedes,
		).length;
		if (count >= MAX_ACTIVE_FILES) throw new Error("File evidence limit reached (32 active sources per working set).");
	}

	update(operation: EvidenceEvent, signal?: AbortSignal): Promise<EvidenceLiveResultV2> {
		const copy = structuredClone(operation);
		return this.run(signal, async (binding, combined) => {
			const base = await this.sync(binding, combined);
			const { next, operationId } = this.append(binding, base, copy, combined);
			return this.finish(
				binding,
				{
					...this.result(binding, next, "update"),
					committed: true,
					operationId,
					cancelledAfterAppend: combined.aborted,
				},
				true,
			);
		});
	}

	private async checkSources(binding: Binding, base: EvidenceReplayResult, signal: AbortSignal) {
		const files = base.state.records.filter(
			({ record }) =>
				record.status === "active" &&
				record.source?.kind === "file" &&
				(base.state.semantics === 3 ? !(record as SemanticRecord).reviewOverflow : !record.review),
		);
		const hashes = new Map<string, string | null>();
		for (const { record } of files) {
			if (record.source?.kind !== "file" || hashes.has(record.source.path)) continue;
			let hash: string | null = null;
			try {
				hash = (await this.sources.read(binding.ctx.cwd, record.source.path, signal)).sha256;
			} catch {
				this.guardSource(binding, base, signal);
			}
			this.guardSource(binding, base, signal);
			hashes.set(record.source.path, hash);
		}
		let operationId: string | undefined;
		for (const { record } of files) {
			if (record.source?.kind !== "file" || hashes.get(record.source.path) === record.source.sha256) continue;
			const code = hashes.get(record.source.path) === null ? "source_unavailable" : "source_changed";
			const reason = "Source changed or is unavailable; preserved excerpt is historical, not current file evidence.";
			if (base.state.semantics === 3 && !this.needsReason(record as SemanticRecord, code, reason)) continue;
			const appended = this.append(
				binding,
				base,
				{
					version: 1,
					action: "review",
					id: record.id,
					reason,
				},
				signal,
				code,
			);
			base = appended.next;
			operationId = appended.operationId;
			if (signal.aborted) break;
		}
		return { next: base, operationId };
	}

	execute(params: Static<typeof EvidenceOperationParams>, signal?: AbortSignal): Promise<EvidenceLiveResultV2> {
		const request = structuredClone(params);
		return this.run(signal, async (binding, combined) => {
			if (!Value.Check(EvidenceOperationParams, request)) throw new Error("Invalid evidence request.");
			const options = { offset: request.offset, limit: request.limit };
			pagination(options);
			let base = await this.sync(binding, combined);
			if (request.concerns !== undefined || request.resolvedBy !== undefined) {
				if (base.mode !== "v3")
					throw new Error("Explicit relationships require a new v3 session; existing sessions are not upgraded.");
				if (request.refs !== undefined) throw new Error("Use explicit relationships or refs, not both.");
				if (request.concerns !== undefined && (request.action !== "add" || request.kind !== "gap"))
					throw new Error("concerns requires add gap.");
				if (request.resolvedBy !== undefined && request.action !== "resolve")
					throw new Error("resolvedBy requires resolve.");
			}
			let selectedId = request.id;
			let operationId: string | undefined;
			if (request.action !== "list" && (!base.writable || binding.store.appendUncertain))
				throw new Error("Evidence writes are read-only or locked.");
			if (request.action === "check") {
				const checked = await this.checkSources(binding, base, combined);
				base = checked.next;
				operationId = checked.operationId;
			} else if (request.action === "add") {
				if (!request.kind || !request.text?.trim()) throw new Error("add requires kind and non-empty text.");
				if (base.state.records.length >= MAX_RECORDS)
					throw new Error(
						"Evidence capacity reached (512 retained records). Retraction does not free slots; prepare a rollover preview for user-confirmed commit.",
					);
				let source: EvidenceRecord["source"];
				if (request.kind === "evidence") {
					if (!request.path) throw new Error("File evidence requires path and a bounded line range (default: line 1).");
					this.fileCapacity(base, request.supersedes);
					source = await this.sources.capture(
						binding.ctx.cwd,
						request.path,
						request.startLine,
						request.endLine,
						combined,
					);
					this.guardSource(binding, base, combined);
				} else if (request.path) throw new Error("Only evidence records accept a file source.");
				const record: EvidenceRecord = {
					id: randomUUID(),
					kind: request.kind,
					text: request.text.trim(),
					createdAt: new Date().toISOString(),
					status: "active",
					refs: request.concerns ?? request.refs ?? [],
					applicability: request.applicability ?? (request.kind === "claim" ? "current" : "historical"),
					source,
					supersedes: request.supersedes,
					automatic: false,
				};
				const appended = this.append(binding, base, { version: 1, action: "add", record }, combined);
				base = appended.next;
				operationId = appended.operationId;
				selectedId = record.id;
			} else if (request.action === "retract" || request.action === "resolve") {
				if (!request.id || !request.reason?.trim()) throw new Error("This action requires id and reason.");
				const appended = this.append(
					binding,
					base,
					{
						version: 1,
						action: request.action,
						id: request.id,
						reason: request.reason.trim(),
						refs: request.resolvedBy ?? request.refs,
					},
					combined,
				);
				base = appended.next;
				operationId = appended.operationId;
			}
			const filtered = [...base.state.records]
				.reverse()
				.filter(({ record }) =>
					selectedId
						? record.id === selectedId
						: (request.includeInactive || record.status === "active") &&
							(!request.kind || record.kind === request.kind),
				);
			if (selectedId && !filtered.length) throw new Error("Record not found on the active branch.");
			const records = page(filtered, { ...options, ...(selectedId ? { offset: 0 } : {}) });
			const action = request.action === "list" || request.action === "check" ? request.action : "update";
			return this.finish(
				binding,
				{
					...this.result(binding, base, action),
					records: records.items,
					total: records.total,
					nextOffset: records.nextOffset,
					...(operationId ? { committed: true as const, operationId, cancelledAfterAppend: combined.aborted } : {}),
				},
				request.action !== "list",
			);
		});
	}

	audit(params: Static<typeof AuditParams>, signal?: AbortSignal): Promise<AuditResult> {
		const request = structuredClone(params);
		return this.run(signal, async (binding, combined) => {
			if (!Value.Check(AuditParams, request))
				throw new Error("Audit requires 1-20 unique selected claim IDs and bounded pagination.");
			const cursor = new EvidenceBranchReplay(binding.ctx.sessionManager);
			let base: EvidenceReplayResult;
			for (;;) {
				this.guard(binding);
				combined.throwIfAborted();
				const progress = cursor.step();
				if (progress.complete && progress.result) {
					base = progress.result;
					break;
				}
				await this.yieldPage();
			}
			this.guardSource(binding, base, combined);
			const available =
				base.writable &&
				!binding.store.appendUncertain &&
				!binding.initializePending &&
				(!binding.requiresSemantic || base.state.semantics === 3);
			const plan = planAudit(base.state, request.selected);
			const hashes = new Map<string, string | null>();
			for (const [id, claims] of plan.sources) {
				const source = plan.records.get(id)?.source;
				if (source?.kind !== "file") continue;
				let code: "source_changed" | "source_unavailable" | "source_not_checked" | undefined;
				if (!available || (!hashes.has(source.path) && hashes.size >= 32)) code = "source_not_checked";
				else {
					if (!hashes.has(source.path)) {
						let hash: string | null = null;
						try {
							hash = (await this.sources.read(binding.ctx.cwd, source.path, combined)).sha256;
						} catch {
							this.guardSource(binding, base, combined);
						}
						this.guardSource(binding, base, combined);
						hashes.set(source.path, hash);
					}
					if (hashes.get(source.path) === null) code = "source_unavailable";
					else if (hashes.get(source.path) !== source.sha256) code = "source_changed";
				}
				if (code) for (const claim of claims) plan.findings.push({ claim, record: id, code });
			}
			this.guardSource(binding, base, combined);
			const offset = request.offset ?? 0;
			const end = offset + (request.limit ?? 20);
			const result: AuditResult = {
				version: 1,
				action: "audit",
				advisory: true,
				setId: base.state.setId,
				anchor: base.anchor,
				available,
				...(!available
					? {
							issue:
								base.issue?.message.slice(0, 2000) ??
								"Evidence history is locked or initialization is unavailable; assessment is incomplete.",
						}
					: {}),
				selected: request.selected,
				claims: plan.claims,
				findings: plan.findings.slice(offset, end),
				total: plan.findings.length,
				nextOffset: end < plan.findings.length ? end : null,
				filesChecked: hashes.size,
				legacyRelationships: base.state.semantics !== 3,
				invalidEvents: base.state.invalidEvents,
				capacityReached: ledger(base).summary().capacityReached,
				navigationReviewPending: binding.reviewPending,
				warning: AUDIT_WARNING,
			};
			if (!Value.Check(AuditResultSchema, result)) throw new Error("Invalid bounded audit result.");
			return result;
		});
	}

	check(options: EvidencePageOptions = {}, signal?: AbortSignal): Promise<EvidenceLiveResultV2> {
		return this.execute({ ...options, action: "check", includeInactive: true }, signal);
	}

	recover(signal?: AbortSignal): Promise<EvidenceLiveResultV2> {
		return this.run(signal, async (binding, combined) => {
			const base = await this.sync(binding, combined, true);
			this.guard(binding);
			combined.throwIfAborted();
			if (binding.requiresSemantic && base.state.semantics !== 3)
				throw new Error(
					"No semantic initialization was recorded; start a new session. Recovery will not retry initialization.",
				);
			binding.store.recover(base);
			this.preview = undefined;
			return this.finish(binding, this.result(binding, base, "recover"), true);
		});
	}

	archive(
		locatorOrCursor: ArchiveLocator | string,
		options: EvidencePageOptions = {},
		signal?: AbortSignal,
	): Promise<EvidenceArchiveResultV2> {
		const request = structuredClone(locatorOrCursor);
		return this.run(signal, async (binding, combined) => {
			const { offset, limit } = pagination(options);
			const token = typeof request === "string" ? request : this.archives.begin(binding.ctx.sessionManager, request);
			combined.throwIfAborted();
			const archive = this.archives.read(token, offset, limit);
			combined.throwIfAborted();
			return this.finish(binding, {
				version: archive.semantics === 3 ? 3 : 2,
				action: "archive",
				warning: WARNING,
				records: archive.records,
				total: archive.total ?? null,
				nextOffset: archive.nextOffset ?? null,
				...(archive.issue ? { issue: archive.issue.message.slice(0, 2000) } : {}),
				archive: {
					complete: archive.complete,
					available: archive.available,
					cursor: archive.cursor,
					inspected: archive.inspected,
					...(archive.setId ? { setId: archive.setId } : {}),
					...(archive.anchor ? { anchor: archive.anchor } : {}),
				},
			});
		});
	}

	observeStart(id: string, name: string): void {
		if (this.binding && OBSERVED.has(name)) this.calls.set(id, this.generation);
	}

	observeResult(event: ToolResultEvent): Promise<void> {
		const generation = this.calls.get(event.toolCallId);
		this.calls.delete(event.toolCallId);
		if (generation !== this.generation || !this.binding) return Promise.resolve();
		const observation = receipt(event);
		const name = event.toolName;
		return this.run(undefined, async (binding, signal) => {
			let base = await this.sync(binding, signal);
			if (!base.writable || binding.store.appendUncertain) return;
			if (MUTATING.has(name))
				base = this.reviewCurrent(binding, base, `${name} completed; reassess current worktree claims.`, signal);
			if (observation && ledger(base).summary().receipts < MAX_RECEIPTS && base.state.records.length < MAX_RECORDS)
				base = this.append(
					binding,
					base,
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
					signal,
				).next;
			this.finish(binding, this.result(binding, base, "update"), true);
		});
	}
}
