import { randomUUID } from "node:crypto";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { ENTRY_TYPE, type EvidenceEvent, EvidenceLedger } from "./model.ts";
import {
	applyScopedEvent,
	canonicalJson,
	eventDigest,
	type InitializeEvent,
	InitializeSchema,
	legacyWorkingSet,
	projectionDigest,
	type RolloverEvent,
	RolloverSchema,
	type ScopedEvent,
	ScopedEventSchema,
	SEMANTIC_ENTRY_TYPE,
	SemanticRolloverSchema,
	SemanticScopedSchema,
	validateRollover,
	WORKING_SET_ENTRY_TYPE,
	type WorkingSet,
} from "./working-set.ts";

export const REPLAY_PAGE_ENTRIES = 2048;
export const MAX_REPLAY_BRANCH_ENTRIES = 8192;
export const MAX_ARCHIVE_PAGE_RECORDS = 20;
export const MAX_ARCHIVE_CURSORS = 2;

export type EvidenceReplayMode = "empty" | "legacy" | "v2" | "v3" | "read-only";
type EvidenceSessionManager = Pick<SessionManager, "getEntry" | "getLeafId">;

export interface EvidenceReplayIssue {
	code:
		| "stale_branch"
		| "missing_ancestor"
		| "scan_limit"
		| "malformed_v2"
		| "mixed_writer"
		| "invalid_transition"
		| "duplicate_operation"
		| "duplicate_set";
	message: string;
	entryId?: string;
}

export interface EvidenceReplayResult {
	mode: EvidenceReplayMode;
	writable: boolean;
	state: WorkingSet;
	anchor: string | null;
	branchLeaf: string | null;
	branchEntries: number;
	ancestryIdentity: string;
	operationIds: ReadonlySet<string>;
	setIds: ReadonlySet<string>;
	issue?: EvidenceReplayIssue;
}

export interface EvidenceReplayProgress {
	complete: boolean;
	phase: "authorize" | "collect" | "replay" | "complete";
	inspected: number;
	collected: number;
	result?: EvidenceReplayResult;
	issue?: EvidenceReplayIssue;
}

function ancestryIdentity(entry: SessionEntry | undefined, prefix: "evidence" | "root"): string {
	return entry ? `${prefix}:${entry.id}:${entry.timestamp}` : "empty-session";
}

function customEvidenceEntry(entry: SessionEntry): boolean {
	return (
		entry.type === "custom" &&
		(entry.customType === ENTRY_TYPE ||
			entry.customType === WORKING_SET_ENTRY_TYPE ||
			entry.customType === SEMANTIC_ENTRY_TYPE)
	);
}

class ReplayAccumulator {
	private readonly ledger = new EvidenceLedger();
	private state: WorkingSet | undefined;
	private mode: EvidenceReplayMode = "empty";
	private identity: string | undefined;
	private readonly operationIds = new Set<string>();
	private readonly setIds = new Set<string>();
	private issue: EvidenceReplayIssue | undefined;
	private readonly rootIdentity: string;

	constructor(rootIdentity: string, seed?: EvidenceReplayResult) {
		this.rootIdentity = rootIdentity;
		if (!seed) return;
		this.mode = seed.mode;
		if (seed.mode !== "empty") this.identity = seed.ancestryIdentity;
		if (seed.mode === "v2" || seed.mode === "v3") {
			this.state = structuredClone(seed.state);
			for (const id of seed.setIds) this.setIds.add(id);
		} else {
			for (const { record } of seed.state.records) this.ledger.records.set(record.id, structuredClone(record));
			this.ledger.invalidEvents = seed.state.invalidEvents;
		}
		for (const id of seed.operationIds) this.operationIds.add(id);
	}

	private predecessor(): WorkingSet {
		if (this.state) return this.state;
		this.identity ??= this.rootIdentity;
		return legacyWorkingSet(this.ledger, this.identity);
	}

	apply(entry: SessionEntry): void {
		if (this.issue || entry.type !== "custom") return;
		if (entry.customType === ENTRY_TYPE) {
			if (this.state) {
				this.fail("mixed_writer", "A v1 evidence event appears after v2 migration; the branch is read-only.", entry.id);
				return;
			}
			this.identity ??= ancestryIdentity(entry, "evidence");
			this.mode = "legacy";
			this.ledger.apply(entry.data);
			return;
		}
		if (entry.customType !== WORKING_SET_ENTRY_TYPE && entry.customType !== SEMANTIC_ENTRY_TYPE) return;
		const value = entry.data;
		if (entry.customType === SEMANTIC_ENTRY_TYPE && Value.Check(InitializeSchema, value)) {
			if (
				this.mode !== "empty" ||
				this.state ||
				this.operationIds.has(value.operationId) ||
				this.setIds.has(value.setId)
			) {
				this.fail("invalid_transition", "Semantic initialization cannot upgrade existing evidence history.", entry.id);
				return;
			}
			this.state = { setId: value.setId, records: [], invalidEvents: 0, semantics: 3 };
			this.mode = "v3";
			this.operationIds.add(value.operationId);
			this.setIds.add(value.setId);
			return;
		}
		const semantic = entry.customType === SEMANTIC_ENTRY_TYPE;
		if (
			!(semantic
				? Value.Check(SemanticRolloverSchema, value) || Value.Check(SemanticScopedSchema, value)
				: Value.Check(RolloverSchema, value) || Value.Check(ScopedEventSchema, value))
		) {
			this.fail("malformed_v2", "Malformed or unsupported v2 evidence history; the branch is read-only.", entry.id);
			return;
		}
		if (
			!Value.Check(RolloverSchema, value) &&
			!Value.Check(ScopedEventSchema, value) &&
			!Value.Check(SemanticRolloverSchema, value) &&
			!Value.Check(SemanticScopedSchema, value)
		)
			return;
		if ((this.state?.semantics === 3) !== semantic) {
			this.fail("mixed_writer", "Evidence writer semantics differ from the active working set.", entry.id);
			return;
		}
		if (this.operationIds.has(value.operationId)) {
			this.fail("duplicate_operation", `Duplicate evidence operation ${value.operationId}.`, entry.id);
			return;
		}
		if (!entry.parentId) {
			this.fail("invalid_transition", "A v2 evidence event has no predecessor anchor.", entry.id);
			return;
		}
		try {
			if (value.action === "rollover") {
				if (this.setIds.has(value.setId)) throw new Error(`Duplicate evidence working set ${value.setId}.`);
				const before = this.predecessor();
				this.state = validateRollover(before, entry.parentId, value, eventDigest(value));
				this.setIds.add(value.setId);
			} else {
				if (!this.state) throw new Error("A scoped v2 update appears before a rollover snapshot.");
				this.state = applyScopedEvent(this.state, entry.parentId, value);
			}
			this.operationIds.add(value.operationId);
			this.mode = semantic ? "v3" : "v2";
		} catch (error) {
			const message = error instanceof Error ? error.message : "Invalid evidence transition.";
			this.fail(
				message.startsWith("Duplicate evidence working set ") ? "duplicate_set" : "invalid_transition",
				message,
				entry.id,
			);
		}
	}

	private fail(code: EvidenceReplayIssue["code"], message: string, entryId?: string): void {
		this.issue = { code, message, entryId };
		this.mode = "read-only";
	}

	finish(anchor: string | null, branchLeaf: string | null, branchEntries: number): EvidenceReplayResult {
		this.identity ??= this.rootIdentity;
		let state = this.state;
		if (!state) {
			try {
				state = legacyWorkingSet(this.ledger, this.identity);
			} catch (error) {
				this.fail(
					"invalid_transition",
					error instanceof Error ? error.message : "Legacy evidence cannot be represented safely.",
				);
				state = { setId: `legacy:${"0".repeat(64)}`, records: [], invalidEvents: this.ledger.invalidEvents };
			}
		}
		return {
			mode: this.issue ? "read-only" : this.mode,
			writable: !this.issue,
			state,
			anchor,
			branchLeaf,
			branchEntries,
			ancestryIdentity: this.identity,
			operationIds: new Set(this.operationIds),
			setIds: new Set([...this.setIds, state.setId]),
			issue: this.issue,
		};
	}
}

export class EvidenceBranchReplay {
	private readonly manager: EvidenceSessionManager;
	private readonly startingLeaf: string | null;
	private readonly targetAnchor: string | null;
	private readonly maxBranchEntries: number;
	private phase: EvidenceReplayProgress["phase"];
	private authorizationCursor: string | null;
	private collectionCursor: string | null;
	private readonly reverseIds: string[] = [];
	private replayOffset = 0;
	private accumulator: ReplayAccumulator | undefined;
	private result: EvidenceReplayResult | undefined;
	private terminalIssue: EvidenceReplayIssue | undefined;
	private rootIdentity = "empty-session";
	private authorizationEntries = 0;
	private branchEntries = 0;
	private readonly seed: EvidenceReplayResult | undefined;
	private seeded = false;

	get reusedProjection(): boolean {
		return this.seeded;
	}

	constructor(
		manager: EvidenceSessionManager,
		targetAnchor: string | null = manager.getLeafId(),
		maxBranchEntries = MAX_REPLAY_BRANCH_ENTRIES,
		seed?: EvidenceReplayResult,
	) {
		this.manager = manager;
		this.seed = seed?.writable && seed.anchor === seed.branchLeaf && seed.anchor !== null ? seed : undefined;
		this.maxBranchEntries = maxBranchEntries;
		this.startingLeaf = manager.getLeafId();
		this.targetAnchor = targetAnchor;
		this.authorizationCursor = this.startingLeaf;
		this.collectionCursor = targetAnchor;
		this.phase = targetAnchor === this.startingLeaf ? "collect" : "authorize";
		if (targetAnchor === null && this.startingLeaf !== null)
			this.fail("missing_ancestor", "The empty root is not a replayable evidence archive anchor.");
	}

	step(maxEntries = REPLAY_PAGE_ENTRIES): EvidenceReplayProgress {
		if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > REPLAY_PAGE_ENTRIES)
			throw new Error(`Replay page must contain 1-${REPLAY_PAGE_ENTRIES} entries.`);
		if (this.phase === "complete") return this.progress(0);
		if (this.manager.getLeafId() !== this.startingLeaf) {
			this.fail("stale_branch", "The active branch changed during evidence replay.");
			return this.progress(0);
		}
		let inspected = 0;
		while (inspected < maxEntries && this.phase !== "complete") {
			if (this.phase === "authorize") {
				const id = this.authorizationCursor;
				if (id === null) {
					this.fail("missing_ancestor", "The requested archive anchor is not on the active branch.");
					break;
				}
				if (id === this.targetAnchor) {
					this.phase = "collect";
					continue;
				}
				if (this.authorizationEntries >= this.maxBranchEntries) {
					this.fail("scan_limit", `Archive authorization exceeds ${this.maxBranchEntries} entries.`);
					break;
				}
				const entry = this.manager.getEntry(id);
				inspected++;
				this.authorizationEntries++;
				if (!entry) {
					this.fail("missing_ancestor", `Missing session entry ${id} while authorizing archive ancestry.`);
					break;
				}
				this.authorizationCursor = entry.parentId;
				continue;
			}
			if (this.phase === "collect") {
				const id = this.collectionCursor;
				const seed = this.seed?.anchor === id ? this.seed : undefined;
				if (id === null || seed) {
					this.branchEntries = this.reverseIds.length + (seed?.branchEntries ?? 0);
					if (this.branchEntries > this.maxBranchEntries) {
						this.fail("scan_limit", `Evidence replay ancestry exceeds ${this.maxBranchEntries} entries.`);
						break;
					}
					this.seeded = !!seed;
					this.accumulator = new ReplayAccumulator(seed?.ancestryIdentity ?? this.rootIdentity, seed);
					this.replayOffset = this.reverseIds.length - 1;
					this.phase = "replay";
					continue;
				}
				if (this.authorizationEntries + this.reverseIds.length >= this.maxBranchEntries) {
					this.fail("scan_limit", `Evidence replay ancestry exceeds ${this.maxBranchEntries} entries.`);
					break;
				}
				const entry = this.manager.getEntry(id);
				inspected++;
				if (!entry) {
					this.fail("missing_ancestor", `Missing session entry ${id} while collecting evidence ancestry.`);
					break;
				}
				this.reverseIds.push(id);
				this.rootIdentity = ancestryIdentity(entry, "root");
				this.collectionCursor = entry.parentId;
				continue;
			}
			if (this.phase === "replay") {
				if (this.replayOffset < 0) {
					this.result = this.accumulator?.finish(this.targetAnchor, this.startingLeaf, this.branchEntries);
					this.phase = "complete";
					continue;
				}
				const id = this.reverseIds[this.replayOffset--];
				const entry = this.manager.getEntry(id);
				inspected++;
				if (!entry) {
					this.fail("missing_ancestor", `Missing session entry ${id} while replaying evidence ancestry.`);
					break;
				}
				this.accumulator?.apply(entry);
			}
		}
		return this.progress(inspected);
	}

	private fail(code: EvidenceReplayIssue["code"], message: string): void {
		this.terminalIssue = { code, message };
		const accumulator = this.accumulator ?? new ReplayAccumulator(this.rootIdentity);
		const partial = accumulator.finish(this.targetAnchor, this.startingLeaf, this.branchEntries);
		this.result = { ...partial, mode: "read-only", writable: false, issue: this.terminalIssue };
		this.phase = "complete";
	}

	private progress(inspected: number): EvidenceReplayProgress {
		return {
			complete: this.phase === "complete",
			phase: this.phase,
			inspected,
			collected: this.reverseIds.length,
			result: this.result,
			issue: this.terminalIssue ?? this.result?.issue,
		};
	}
}

export function replayEvidenceBranch(manager: EvidenceSessionManager): EvidenceReplayResult {
	const replay = new EvidenceBranchReplay(manager);
	for (;;) {
		const progress = replay.step();
		if (progress.complete && progress.result) return progress.result;
	}
}

export interface ArchiveLocator {
	setId: string;
	anchor: string;
	digest: string;
}

export interface ArchivePage {
	semantics?: 3;
	complete: boolean;
	available: boolean;
	cursor: string | null;
	inspected: number;
	issue?: EvidenceReplayIssue | { code: "locator_mismatch" | "cursor_expired"; message: string };
	setId?: string;
	anchor?: string;
	records: WorkingSet["records"];
	total?: number;
	nextOffset?: number | null;
}

interface ArchiveCursorState {
	manager: EvidenceSessionManager;
	locator: ArchiveLocator;
	replay: EvidenceBranchReplay;
	result?: EvidenceReplayResult;
	lastUsed: number;
}

export class EvidenceArchiveReader {
	private readonly cursors = new Map<string, ArchiveCursorState>();
	private clock = 0;

	begin(manager: EvidenceSessionManager, locator: ArchiveLocator): string {
		const token = randomUUID();
		this.cursors.set(token, {
			manager,
			locator: structuredClone(locator),
			replay: new EvidenceBranchReplay(manager, locator.anchor),
			lastUsed: ++this.clock,
		});
		if (this.cursors.size > MAX_ARCHIVE_CURSORS) {
			const oldest = [...this.cursors].sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0]?.[0];
			if (oldest) this.cursors.delete(oldest);
		}
		return token;
	}

	read(token: string, offset = 0, limit = 10): ArchivePage {
		if (
			!Number.isInteger(offset) ||
			offset < 0 ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > MAX_ARCHIVE_PAGE_RECORDS
		)
			throw new Error(`Archive pagination requires offset >= 0 and limit 1-${MAX_ARCHIVE_PAGE_RECORDS}.`);
		const cursor = this.cursors.get(token);
		if (!cursor)
			return {
				complete: true,
				available: false,
				cursor: null,
				inspected: 0,
				issue: { code: "cursor_expired", message: "Archive continuation expired; begin a new bounded scan." },
				records: [],
			};
		cursor.lastUsed = ++this.clock;
		let inspected = 0;
		if (cursor.result && cursor.result.branchLeaf !== cursor.manager.getLeafId()) {
			this.cursors.delete(token);
			return {
				complete: true,
				available: false,
				cursor: null,
				inspected: 0,
				issue: { code: "stale_branch", message: "The active branch changed during archive pagination." },
				records: [],
			};
		}
		if (!cursor.result) {
			const progress = cursor.replay.step();
			inspected = progress.inspected;
			if (!progress.complete)
				return { complete: false, available: false, cursor: token, inspected: progress.inspected, records: [] };
			cursor.result = progress.result;
			if (!cursor.result || cursor.result.issue) {
				this.cursors.delete(token);
				return {
					complete: true,
					available: false,
					cursor: null,
					inspected: progress.inspected,
					issue: cursor.result?.issue ?? progress.issue,
					records: [],
				};
			}
		}
		const { locator, result } = cursor;
		if (
			result.state.setId !== locator.setId ||
			projectionDigest(result.state) !== locator.digest ||
			result.anchor !== locator.anchor
		) {
			this.cursors.delete(token);
			return {
				complete: true,
				available: false,
				cursor: null,
				inspected,
				issue: {
					code: "locator_mismatch",
					message: "Archive locator does not match the validated ancestry projection.",
				},
				records: [],
			};
		}
		const end = offset + limit;
		return {
			complete: true,
			available: true,
			cursor: token,
			inspected,
			...(result.state.semantics === 3 ? { semantics: 3 as const } : {}),
			setId: result.state.setId,
			anchor: result.anchor ?? undefined,
			records: structuredClone(result.state.records.slice(offset, end)),
			total: result.state.records.length,
			nextOffset: end < result.state.records.length ? end : null,
		};
	}

	clear(): void {
		this.cursors.clear();
	}
}

export class UncertainEvidenceAppendError extends Error {
	readonly operationId: string;
	readonly visibleOnActiveAncestry: boolean;

	constructor(message: string, operationId: string, visibleOnActiveAncestry: boolean, options?: ErrorOptions) {
		super(message, options);
		this.name = "UncertainEvidenceAppendError";
		this.operationId = operationId;
		this.visibleOnActiveAncestry = visibleOnActiveAncestry;
	}
}

export class EvidenceSessionStore {
	private uncertain: UncertainEvidenceAppendError | undefined;
	private readonly manager: EvidenceSessionManager;
	private readonly appendEntry: (customType: string, data: unknown) => void;

	constructor(manager: EvidenceSessionManager, appendEntry: (customType: string, data: unknown) => void) {
		this.manager = manager;
		this.appendEntry = appendEntry;
	}

	get appendUncertain(): boolean {
		return !!this.uncertain;
	}

	recover(replay: EvidenceReplayResult): void {
		const leaf = this.manager.getLeafId();
		if (replay.branchLeaf !== leaf || replay.anchor !== leaf || !replay.writable)
			throw new Error("Recovery requires a fresh, coherent replay of the current branch.");
		this.uncertain = undefined;
	}

	initialize(base: EvidenceReplayResult, signal?: AbortSignal): EvidenceReplayResult {
		const event: InitializeEvent = { version: 3, action: "initialize", operationId: randomUUID(), setId: randomUUID() };
		this.preflight(base, event.operationId, signal);
		if (base.mode !== "empty" || base.state.records.length || base.state.invalidEvents)
			throw new Error("Semantic initialization requires a fresh evidence history.");
		return this.append(base, event, { setId: event.setId, records: [], invalidEvents: 0, semantics: 3 }, signal);
	}

	commitRollover(
		base: EvidenceReplayResult,
		event: RolloverEvent,
		previewToken: string,
		signal?: AbortSignal,
	): EvidenceReplayResult {
		this.preflight(base, event.operationId, signal);
		if (base.setIds.has(event.setId))
			throw new Error(`Evidence working set ${event.setId} already exists on this ancestry.`);
		if (!base.anchor) throw new Error("Evidence rollover requires a non-empty predecessor anchor.");
		const next = validateRollover(base.state, base.anchor, event, previewToken);
		return this.append(base, event, next, signal);
	}

	commitLegacy(base: EvidenceReplayResult, event: EvidenceEvent, signal?: AbortSignal): EvidenceReplayResult {
		const attemptId = randomUUID();
		this.preflight(base, attemptId, signal);
		if (base.mode !== "empty" && base.mode !== "legacy")
			throw new Error("Legacy updates require an unmigrated evidence branch.");
		const ledger = new EvidenceLedger();
		for (const { record } of base.state.records) ledger.records.set(record.id, structuredClone(record));
		ledger.invalidEvents = base.state.invalidEvents;
		if (!ledger.apply(event))
			throw new Error("Invalid evidence update: check active IDs, kinds, references, and capacity.");
		legacyWorkingSet(ledger, base.ancestryIdentity);
		const entry = this.appendVerified(base.anchor, ENTRY_TYPE, event, attemptId, signal);
		const identity = base.mode === "empty" ? ancestryIdentity(entry, "evidence") : base.ancestryIdentity;
		return {
			...base,
			mode: "legacy",
			state: legacyWorkingSet(ledger, identity),
			anchor: entry.id,
			branchLeaf: entry.id,
			branchEntries: base.branchEntries + 1,
			ancestryIdentity: identity,
		};
	}

	commitScoped(base: EvidenceReplayResult, event: ScopedEvent, signal?: AbortSignal): EvidenceReplayResult {
		this.preflight(base, event.operationId, signal);
		if ((base.mode !== "v2" && base.mode !== "v3") || !base.anchor)
			throw new Error("Scoped updates require an initialized working set.");
		const next = applyScopedEvent(base.state, base.anchor, event);
		return this.append(base, event, next, signal);
	}

	private preflight(base: EvidenceReplayResult, operationId: string, signal?: AbortSignal): void {
		if (this.uncertain) throw new Error("Evidence writes are locked until uncertain append recovery completes.");
		if (!base.writable) throw new Error(base.issue?.message ?? "Evidence history is read-only.");
		if (base.branchLeaf !== this.manager.getLeafId() || base.anchor !== this.manager.getLeafId())
			throw new Error("Evidence branch changed; replay and preview again.");
		if (base.branchEntries >= MAX_REPLAY_BRANCH_ENTRIES)
			throw new Error(`Evidence append would exceed the ${MAX_REPLAY_BRANCH_ENTRIES}-entry ancestry replay limit.`);
		if (base.operationIds.has(operationId))
			throw new Error(`Evidence operation ${operationId} already exists on this ancestry.`);
		signal?.throwIfAborted();
	}

	private append(
		base: EvidenceReplayResult,
		event: RolloverEvent | ScopedEvent | InitializeEvent,
		next: WorkingSet,
		signal?: AbortSignal,
	): EvidenceReplayResult {
		const leaf = this.appendVerified(
			base.anchor,
			event.version === 3 ? SEMANTIC_ENTRY_TYPE : WORKING_SET_ENTRY_TYPE,
			event,
			event.operationId,
			signal,
		).id;
		const operationIds = new Set(base.operationIds);
		operationIds.add(event.operationId);
		const setIds = new Set(base.setIds);
		setIds.add(event.setId);
		return {
			mode: event.version === 3 ? "v3" : "v2",
			writable: true,
			state: next,
			anchor: leaf,
			branchLeaf: leaf,
			branchEntries: base.branchEntries + 1,
			ancestryIdentity: base.ancestryIdentity,
			operationIds,
			setIds,
		};
	}

	private appendVerified(
		parent: string | null,
		customType: string,
		event: EvidenceEvent | RolloverEvent | ScopedEvent | InitializeEvent,
		operationId: string,
		signal?: AbortSignal,
	): Extract<SessionEntry, { type: "custom" }> {
		signal?.throwIfAborted();
		try {
			this.appendEntry(customType, event);
		} catch (cause) {
			const visible = this.matchingEventLeaf(parent, customType, event) !== null;
			this.uncertain = new UncertainEvidenceAppendError(
				visible
					? "Evidence append threw after the event became visible in memory; outcome is uncertain and writes are locked."
					: "Evidence append failed before a matching event was visible; durability is still uncertain and writes are locked.",
				operationId,
				visible,
				{ cause },
			);
			throw this.uncertain;
		}
		const entry = this.matchingEventLeaf(parent, customType, event);
		if (!entry) {
			this.uncertain = new UncertainEvidenceAppendError(
				"appendEntry returned without the expected active-ancestry event; writes are locked.",
				operationId,
				false,
			);
			throw this.uncertain;
		}
		return entry;
	}

	private matchingEventLeaf(
		parent: string | null,
		customType: string,
		event: EvidenceEvent | RolloverEvent | ScopedEvent | InitializeEvent,
	): Extract<SessionEntry, { type: "custom" }> | null {
		try {
			const leaf = this.manager.getLeafId();
			const entry = leaf ? this.manager.getEntry(leaf) : undefined;
			return entry?.type === "custom" &&
				entry.customType === customType &&
				entry.parentId === parent &&
				canonicalJson(entry.data) === canonicalJson(event)
				? entry
				: null;
		} catch {
			return null;
		}
	}
}

export function isEvidenceSessionEntry(entry: SessionEntry): boolean {
	return customEvidenceEntry(entry);
}
