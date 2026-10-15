import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { EventSchema, EvidenceLedger, MAX_RECEIPTS, MAX_RECORDS, RecordSchema, SourceSchema } from "./model.ts";

import { SemanticEventSchema, SemanticLedger, type SemanticRecord, SemanticRecordSchema } from "./semantics.ts";

export const SEMANTIC_ENTRY_TYPE = "midnight-evidence-v3";
export const WORKING_SET_ENTRY_TYPE = "midnight-evidence-v2";
export const MAX_CARRIED_RECORDS = 256;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_ACTIVE_FILES = 32;
const closed = { additionalProperties: false };
const id = Type.String({ minLength: 1, maxLength: 100 });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const uuid = Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" });
const setId = Type.Union([uuid, Type.String({ pattern: "^legacy:[a-f0-9]{64}$" })]);
const strictRecord = Type.Object(
	{
		...RecordSchema.properties,
		source: Type.Optional(
			Type.Union([
				Type.Object(SourceSchema.anyOf[0].properties, closed),
				Type.Object(SourceSchema.anyOf[1].properties, closed),
			]),
		),
	},
	closed,
);
const locator = Type.Object({ setId, anchor: id, recordId: id }, closed);
const storedRecord = Type.Object(
	{ record: strictRecord, origin: Type.Optional(locator), replacement: Type.Optional(locator) },
	closed,
);
const projectionSchema = Type.Object(
	{
		setId,
		records: Type.Array(storedRecord, { maxItems: MAX_RECORDS }),
		invalidEvents: Type.Integer({ minimum: 0 }),
	},
	closed,
);
export const SemanticStoredRecordSchema = Type.Object(
	{ record: SemanticRecordSchema, origin: Type.Optional(locator), replacement: Type.Optional(locator) },
	closed,
);
const semanticProjectionSchema = Type.Object(
	{
		...projectionSchema.properties,
		semantics: Type.Literal(3),
		records: Type.Array(SemanticStoredRecordSchema, { maxItems: MAX_RECORDS }),
	},
	closed,
);
export type WorkingSet = {
	setId: string;
	records: Array<{
		record: Static<typeof strictRecord> | SemanticRecord;
		origin?: Static<typeof locator>;
		replacement?: Static<typeof locator>;
	}>;
	invalidEvents: number;
	semantics?: 3;
};
export const InitializeSchema = Type.Object(
	{
		version: Type.Literal(3),
		action: Type.Literal("initialize"),
		operationId: uuid,
		setId: uuid,
	},
	closed,
);
export type InitializeEvent = Static<typeof InitializeSchema>;
export const RolloverSchema = Type.Object(
	{
		version: Type.Literal(2),
		action: Type.Literal("rollover"),
		operationId: uuid,
		setId: uuid,
		predecessor: Type.Object({ setId, anchor: id, digest: hash }, closed),
		selected: Type.Array(id, { maxItems: MAX_CARRIED_RECORDS, uniqueItems: true }),
		records: Type.Array(storedRecord, { maxItems: MAX_CARRIED_RECORDS }),
		invalidEvents: Type.Integer({ minimum: 0 }),
	},
	closed,
);
export const SemanticRolloverSchema = Type.Object(
	{
		...RolloverSchema.properties,
		version: Type.Literal(3),
		records: Type.Array(SemanticStoredRecordSchema, { maxItems: MAX_CARRIED_RECORDS }),
	},
	closed,
);
export type RolloverEvent = Static<typeof RolloverSchema> | Static<typeof SemanticRolloverSchema>;
const strictOperation = Type.Union([
	Type.Object({ ...EventSchema.anyOf[0].properties, record: strictRecord }, closed),
	Type.Object(EventSchema.anyOf[1].properties, closed),
]);
export const ScopedEventSchema = Type.Object(
	{
		version: Type.Literal(2),
		action: Type.Literal("update"),
		operationId: uuid,
		setId: uuid,
		baseAnchor: id,
		baseDigest: hash,
		operation: strictOperation,
	},
	closed,
);
export const SemanticScopedSchema = Type.Object(
	{
		...ScopedEventSchema.properties,
		version: Type.Literal(3),
		operation: SemanticEventSchema,
	},
	closed,
);
export type ScopedEvent = Static<typeof ScopedEventSchema> | Static<typeof SemanticScopedSchema>;

/** JSON-compatible values only. Object keys sort lexically; array order remains significant. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: item,
	);
}
function digest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
export function eventDigest(value: RolloverEvent | ScopedEvent): string {
	return digest(value);
}
export function projectionDigest(state: WorkingSet): string {
	return digest(state);
}

/** Caller supplies a stable session/ancestry identity, never a replay-time random value. */
export function legacyWorkingSet(ledger: EvidenceLedger, ancestryIdentity: string): WorkingSet {
	if (!ancestryIdentity) throw new Error("A stable legacy ancestry identity is required.");
	const state: WorkingSet = {
		setId: `legacy:${digest(ancestryIdentity)}`,
		records: [...ledger.records.values()].map((record) => ({ record: structuredClone(record) })),
		invalidEvents: ledger.invalidEvents,
	};
	validateProjection(state, false);
	return state;
}

function validRelationships(record: SemanticRecord): boolean {
	if (!!record.review !== (record.reviewReasons.length > 0 || record.reviewOverflow)) return false;
	if (record.kind !== "gap") return record.concerns === undefined && record.resolvedBy === undefined;
	if (!record.concerns || (record.status === "resolved" && !record.resolvedBy?.length)) return false;
	const union = new Set([...record.concerns, ...(record.resolvedBy ?? [])]);
	return union.size === record.refs.length && record.refs.every((id) => union.has(id));
}

function validateProjection(state: WorkingSet, enforceLiveBudgets = true): void {
	if (!Value.Check(state.semantics === 3 ? semanticProjectionSchema : projectionSchema, state))
		throw new Error("Invalid working-set projection schema.");
	const records = new Map(state.records.map((entry) => [entry.record.id, entry]));
	if (records.size !== state.records.length) throw new Error("Duplicate record ID.");
	for (const { record, origin, replacement } of state.records) {
		if (
			(record.kind === "evidence" ? !record.source || record.refs.length > 0 : !!record.source) ||
			(record.kind === "claim" && record.refs.length === 0) ||
			(record.status === "resolved" && record.kind !== "gap") ||
			(record.status === "resolved" && record.refs.length === 0) ||
			(state.semantics === 3 && !validRelationships(record as SemanticRecord)) ||
			record.refs.some((ref) => {
				const target = records.get(ref)?.record;
				return (
					!target ||
					ref === record.id ||
					((record.kind === "claim" || (state.semantics !== 3 && record.status === "resolved")) &&
						target.kind !== "evidence") ||
					(state.semantics === 3 && (record as SemanticRecord).resolvedBy?.includes(ref) && target.kind !== "evidence")
				);
			})
		)
			throw new Error(`Invalid semantic dependencies for ${record.id}.`);
		if (origin && (origin.recordId !== record.id || origin.setId === state.setId))
			throw new Error(`Invalid origin for ${record.id}.`);
		if (replacement && replacement.recordId !== record.supersedes)
			throw new Error(`Invalid replacement locator for ${record.id}.`);
		if (record.supersedes) {
			const old = records.get(record.supersedes)?.record;
			if ((!old && !replacement) || (old && old.kind !== record.kind) || record.supersedes === record.id)
				throw new Error(`Missing or invalid replacement lineage for ${record.id}.`);
		}
	}
	// v1 references form a DAG; reject malformed snapshots rather than hiding a cycle in closure traversal.
	const visited = new Set<string>();
	const visiting = new Set<string>();
	function visit(id: string): void {
		if (visiting.has(id)) throw new Error("Cyclic semantic dependencies.");
		if (visited.has(id)) return;
		visiting.add(id);
		for (const ref of records.get(id)?.record.refs ?? []) visit(ref);
		visiting.delete(id);
		visited.add(id);
	}
	for (const id of records.keys()) visit(id);
	if (!enforceLiveBudgets) return;
	const files = state.records.filter(({ record }) => record.source?.kind === "file" && record.status === "active");
	const receipts = state.records.filter(({ record }) => record.automatic);
	if (files.length > MAX_ACTIVE_FILES)
		throw new Error(`Active file limit exceeded: ${files.length}/${MAX_ACTIVE_FILES}.`);
	if (receipts.length > MAX_RECEIPTS) throw new Error(`Receipt limit exceeded: ${receipts.length}/${MAX_RECEIPTS}.`);
}

export interface RolloverPreview {
	event: RolloverEvent;
	token: string;
	bytes: number;
	freeSlots: number;
	omittedActiveIds: string[];
	reviewIds: string[];
	receipts: number;
	warnings: string[];
}

/** Pure planning. This internal result is not a tool response; runtime output must paginate IDs/records. */
export function previewRollover(
	state: WorkingSet,
	anchor: string,
	selected: string[],
	nextSetId: string,
	operationId: string,
): RolloverPreview {
	validateProjection(state, false);
	if (!Value.Check(id, anchor) || !Value.Check(uuid, nextSetId) || !Value.Check(uuid, operationId))
		throw new Error("Invalid branch anchor, new working-set ID or operation ID.");
	if (nextSetId === state.setId) throw new Error("Rollover requires a new working-set identity.");
	if (!Value.Check(RolloverSchema.properties.selected, selected)) throw new Error("Invalid rollover selection.");
	const records = new Map(state.records.map((entry) => [entry.record.id, entry]));
	const closure = new Set<string>();
	const pending = [...selected];
	while (pending.length) {
		const id = pending.pop();
		if (!id || closure.has(id)) continue;
		const entry = records.get(id);
		if (!entry) throw new Error(`Unknown selected/dependency record: ${id}.`);
		closure.add(id);
		pending.push(...entry.record.refs);
	}
	if (closure.size > MAX_CARRIED_RECORDS)
		throw new Error(`Dependency closure is ${closure.size}/${MAX_CARRIED_RECORDS} records; select fewer roots.`);
	const carried = state.records
		.filter(({ record }) => closure.has(record.id))
		.map((entry) => {
			const copy = structuredClone(entry);
			copy.origin = { setId: state.setId, anchor, recordId: entry.record.id };
			if (entry.record.supersedes && records.has(entry.record.supersedes))
				copy.replacement = { setId: state.setId, anchor, recordId: entry.record.supersedes };
			return copy;
		});
	const next = {
		setId: nextSetId,
		records: carried,
		invalidEvents: state.invalidEvents,
		...(state.semantics === 3 ? { semantics: 3 as const } : {}),
	};
	validateProjection(next);
	const event = {
		version: state.semantics === 3 ? 3 : 2,
		action: "rollover",
		operationId,
		setId: nextSetId,
		predecessor: { setId: state.setId, anchor, digest: projectionDigest(state) },
		selected: [...selected].sort(),
		records: carried,
		invalidEvents: state.invalidEvents,
	} as RolloverEvent;
	const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
	if (bytes > MAX_SNAPSHOT_BYTES)
		throw new Error(`Rollover event is ${bytes}/${MAX_SNAPSHOT_BYTES} UTF-8 bytes; select fewer roots.`);
	const omittedActiveIds = state.records
		.filter(({ record }) => record.status === "active" && !closure.has(record.id))
		.map(({ record }) => record.id);
	const receipts = carried.filter(({ record }) => record.automatic).length;
	const warnings = [];
	if (!selected.length) warnings.push("Explicit empty rollover archives all records; omitted gaps are not resolved.");
	if (omittedActiveIds.length) warnings.push(`${omittedActiveIds.length} active records are omitted, not resolved.`);
	if (state.invalidEvents) warnings.push(`${state.invalidEvents} invalid legacy events; provenance is incomplete.`);
	if (receipts === MAX_RECEIPTS) warnings.push("Carried receipts leave no capacity for new automatic receipts.");
	return {
		event,
		token: digest(event),
		bytes,
		freeSlots: MAX_RECORDS - carried.length,
		omittedActiveIds,
		reviewIds: carried.filter(({ record }) => record.review).map(({ record }) => record.id),
		receipts,
		warnings,
	};
}

/** Recompute from the predecessor: a structurally valid agent-supplied snapshot is not trusted. */
export function validateRollover(state: WorkingSet, anchor: string, value: unknown, previewToken: string): WorkingSet {
	if (!Value.Check(RolloverSchema, value) && !Value.Check(SemanticRolloverSchema, value))
		throw new Error("Malformed or unsupported rollover event.");
	if (value.version !== (state.semantics === 3 ? 3 : 2)) throw new Error("Rollover cannot change evidence semantics.");
	const expected = previewRollover(state, anchor, value.selected, value.setId, value.operationId);
	if (expected.token !== previewToken || canonicalJson(value) !== canonicalJson(expected.event))
		throw new Error("Stale preview or altered rollover snapshot; preview the current branch again.");
	return {
		setId: value.setId,
		records: structuredClone(value.records),
		invalidEvents: value.invalidEvents,
		...(value.version === 3 ? { semantics: 3 as const } : {}),
	};
}

/** Isolated reduction. Anchor identifies the predecessor, not the newly appended entry.
 * Runtime must prove ancestry and enforce operation-ID uniqueness; this is not an idempotent append API.
 */
export function applyScopedEvent(state: WorkingSet, anchor: string, value: unknown): WorkingSet {
	validateProjection(state);
	if (!Value.Check(id, anchor)) throw new Error("Invalid branch anchor.");
	if (!Value.Check(ScopedEventSchema, value) && !Value.Check(SemanticScopedSchema, value))
		throw new Error("Malformed, legacy or unsupported scoped event.");
	if (value.version !== (state.semantics === 3 ? 3 : 2))
		throw new Error("Scoped writes cannot change evidence semantics.");
	if (value.setId !== state.setId || value.baseAnchor !== anchor || value.baseDigest !== projectionDigest(state))
		throw new Error("Wrong working set, branch anchor or stale projection digest.");
	const ledger = new EvidenceLedger();
	for (const { record } of state.records) ledger.records.set(record.id, structuredClone(record));
	ledger.invalidEvents = state.invalidEvents;
	if (value.version === 3) {
		const semantic = new SemanticLedger();
		for (const { record } of state.records) semantic.records.set(record.id, structuredClone(record as SemanticRecord));
		if (!semantic.apply(value.operation)) throw new Error("Invalid scoped semantic operation.");
		ledger.records.clear();
		for (const [id, record] of semantic.records) ledger.records.set(id, record);
	} else if (!ledger.apply(value.operation)) throw new Error("Invalid scoped lifecycle operation.");
	const metadata = new Map(state.records.map((entry) => [entry.record.id, entry]));
	const next: WorkingSet = {
		...(state.semantics === 3 ? { semantics: 3 as const } : {}),
		setId: state.setId,
		invalidEvents: ledger.invalidEvents,
		records: [...ledger.records.values()].map((record) => {
			const entry = { ...structuredClone(metadata.get(record.id)), record };
			if (!metadata.has(record.id) && record.supersedes)
				entry.replacement = { setId: state.setId, anchor, recordId: record.supersedes };
			return entry;
		}),
	};
	validateProjection(next);
	return next;
}
