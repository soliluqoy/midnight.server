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
export const PublicEvidenceParams = Type.Union([
	AuditParams,
	EvidenceOperationParams,
	Type.Object(
		{ action: Type.Literal("preview"), selected: Type.Array(id, { maxItems: 256, uniqueItems: true }), ...page },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("archive"),
			locator: Type.Union([
				id,
				Type.Object(
					{ setId: id, anchor: id, digest: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
					{ additionalProperties: false },
				),
			]),
			...page,
		},
		{ additionalProperties: false },
	),
]);
