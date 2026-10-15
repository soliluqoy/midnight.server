import { type Static, Type } from "typebox";
import { AuditResultSchema } from "./audit.ts";
import { MAX_RECORDS, SummarySchema } from "./model.ts";
import { RolloverSchema, SemanticStoredRecordSchema } from "./working-set.ts";

const closed = { additionalProperties: false };
const count = Type.Integer({ minimum: 0, maximum: MAX_RECORDS });
const offset = Type.Integer({ minimum: 0, maximum: MAX_RECORDS });
const identifier = Type.String({ minLength: 1, maxLength: 100 });
const nullableId = Type.Union([identifier, Type.Null()]);
const nextOffset = Type.Union([offset, Type.Null()]);
const ids = Type.Object({ total: count, nextOffset, ids: Type.Array(identifier, { maxItems: 20 }) }, closed);
const common = {
	version: Type.Union([Type.Literal(2), Type.Literal(3)]),
	warning: Type.String({ maxLength: 1000 }),
	mode: Type.Union([
		Type.Literal("empty"),
		Type.Literal("legacy"),
		Type.Literal("v2"),
		Type.Literal("v3"),
		Type.Literal("read-only"),
	]),
	writable: Type.Boolean(),
	appendUncertain: Type.Boolean(),
	setId: identifier,
	anchor: nullableId,
	summary: Type.Object(SummarySchema.properties, closed),
	records: Type.Array(Type.Union([RolloverSchema.properties.records.items, SemanticStoredRecordSchema]), {
		maxItems: 20,
	}),
	total: count,
	nextOffset,
	issue: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
};
const committed = {
	committed: Type.Literal(true),
	operationId: identifier,
	cancelledAfterAppend: Type.Boolean(),
};
export const EvidenceResultV2Schema = Type.Union([
	Type.Object({ ...common, action: Type.Literal("list") }, closed),
	Type.Object({ ...common, action: Type.Literal("recover") }, closed),
	Type.Object(
		{
			...common,
			action: Type.Literal("preview"),
			preview: Type.Object(
				{
					token: Type.String({ pattern: "^[a-f0-9]{64}$" }),
					setId: identifier,
					predecessor: RolloverSchema.properties.predecessor,
					bytes: Type.Integer({ minimum: 0, maximum: 2 * 1024 * 1024 }),
					carried: Type.Integer({ minimum: 0, maximum: 256 }),
					freeSlots: count,
					receipts: count,
					omitted: ids,
					review: ids,
					warnings: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 4 }),
				},
				closed,
			),
		},
		closed,
	),
	Type.Object({ ...common, ...committed, action: Type.Literal("commit") }, closed),
	Type.Object(
		{
			...common,
			action: Type.Literal("update"),
			committed: Type.Optional(committed.committed),
			operationId: Type.Optional(identifier),
			cancelledAfterAppend: Type.Optional(Type.Boolean()),
		},
		closed,
	),
	Type.Object(
		{
			...common,
			action: Type.Literal("check"),
			committed: Type.Optional(committed.committed),
			operationId: Type.Optional(identifier),
			cancelledAfterAppend: Type.Optional(Type.Boolean()),
		},
		closed,
	),
	Type.Object(
		{
			version: common.version,
			warning: common.warning,
			action: Type.Literal("archive"),
			records: common.records,
			total: Type.Union([count, Type.Null()]),
			nextOffset,
			issue: common.issue,
			archive: Type.Object(
				{
					complete: Type.Boolean(),
					available: Type.Boolean(),
					cursor: nullableId,
					inspected: Type.Integer({ minimum: 0, maximum: 2048 }),
					setId: Type.Optional(identifier),
					anchor: Type.Optional(identifier),
				},
				closed,
			),
		},
		closed,
	),
]);
export const PublicEvidenceResultSchema = Type.Union([EvidenceResultV2Schema, AuditResultSchema]);
const CommonSchema = Type.Object(common, closed);
type ResultVariants = Static<typeof EvidenceResultV2Schema>;
export type EvidenceArchiveResultV2 = Extract<ResultVariants, { action: "archive" }>;
export type EvidenceLiveResultV2 = Static<typeof CommonSchema> & {
	action: Exclude<ResultVariants["action"], "archive">;
	preview?: Extract<ResultVariants, { action: "preview" }>["preview"];
	committed?: true;
	operationId?: string;
	cancelledAfterAppend?: boolean;
};
export type EvidenceResultV2 = EvidenceLiveResultV2 | EvidenceArchiveResultV2;
