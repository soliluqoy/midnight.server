import { Type } from "typebox";
import { AuditParams } from "./audit.ts";
import { ParamsSchema } from "./index.ts";

const id = Type.String({ minLength: 1, maxLength: 100 });
const page = {
	offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 512 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
};
export const EvidenceOperationParams = Type.Object(
	{
		...ParamsSchema.properties,
		concerns: Type.Optional(Type.Array(id, { maxItems: 16, uniqueItems: true })),
		resolvedBy: Type.Optional(Type.Array(id, { maxItems: 16, uniqueItems: true })),
	},
	{ additionalProperties: false },
);
const selected = Type.Array(id, { maxItems: 256, uniqueItems: true });
const locator = Type.Union([
	id,
	Type.Object(
		{ setId: id, anchor: id, digest: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
		{ additionalProperties: false },
	),
]);

// Keep action-specific validation, but publish an object-root schema: some providers reject
// a top-level anyOf even when every branch is an object.
export const StrictPublicEvidenceParams = Type.Union([
	AuditParams,
	EvidenceOperationParams,
	Type.Object({ action: Type.Literal("preview"), selected, ...page }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal("archive"), locator, ...page }, { additionalProperties: false }),
]);
export const PublicEvidenceParams = Type.Object(
	{
		...EvidenceOperationParams.properties,
		action: Type.Union([
			EvidenceOperationParams.properties.action,
			Type.Literal("audit"),
			Type.Literal("preview"),
			Type.Literal("archive"),
		]),
		selected: Type.Optional(selected),
		locator: Type.Optional(locator),
	},
	{ additionalProperties: false },
);
