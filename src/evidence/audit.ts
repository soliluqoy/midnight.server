import { type Static, Type } from "typebox";
import type { WorkingSet } from "./working-set.ts";

const id = Type.String({ minLength: 1, maxLength: 100 });
const closed = { additionalProperties: false };
export const AuditParams = Type.Object(
	{
		action: Type.Literal("audit"),
		selected: Type.Array(id, { minItems: 1, maxItems: 20, uniqueItems: true }),
		offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
	},
	closed,
);
export const AuditFindingSchema = Type.Object(
	{
		claim: id,
		record: Type.Optional(id),
		code: Type.Union([
			Type.Literal("missing"),
			Type.Literal("not_claim"),
			Type.Literal("inactive"),
			Type.Literal("review_required"),
			Type.Literal("missing_support"),
			Type.Literal("not_evidence"),
			Type.Literal("receipt_only"),
			Type.Literal("open_concern"),
			Type.Literal("reviewed_concern"),
			Type.Literal("source_changed"),
			Type.Literal("source_unavailable"),
			Type.Literal("source_not_checked"),
		]),
	},
	closed,
);
export type AuditFinding = Static<typeof AuditFindingSchema>;
export const AuditResultSchema = Type.Object(
	{
		version: Type.Literal(1),
		action: Type.Literal("audit"),
		advisory: Type.Literal(true),
		setId: id,
		anchor: Type.Union([id, Type.Null()]),
		available: Type.Boolean(),
		issue: Type.Optional(Type.String({ maxLength: 2000 })),
		selected: Type.Array(id, { minItems: 1, maxItems: 20 }),
		claims: Type.Array(
			Type.Object({ id, applicability: Type.Union([Type.Literal("current"), Type.Literal("historical")]) }, closed),
			{ maxItems: 20 },
		),
		findings: Type.Array(AuditFindingSchema, { maxItems: 20 }),
		total: Type.Integer({ minimum: 0 }),
		nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
		filesChecked: Type.Integer({ minimum: 0, maximum: 32 }),
		legacyRelationships: Type.Boolean(),
		invalidEvents: Type.Integer({ minimum: 0 }),
		capacityReached: Type.Boolean(),
		navigationReviewPending: Type.Boolean(),
		warning: Type.String({ maxLength: 2000 }),
	},
	closed,
);
export type AuditResult = Static<typeof AuditResultSchema>;
export const AUDIT_WARNING =
	"Advisory selected-claim assessment, not truth verification. Only recorded relationships are considered; unrecorded gaps and external state are not checked. File hashes are bounded observations, not transactional or perpetual freshness. Historical applicability and receipts do not prove current behavior. Audit writes nothing and never clears review. Pagination must be inspected; no findings does not mean the answer is correct.";

/** Pure selection, bounded by the working-set cap. No provenance or lifecycle mutation. */
export function planAudit(state: WorkingSet, selected: string[]) {
	const records = new Map(state.records.map(({ record }) => [record.id, record]));
	const findings: AuditFinding[] = [];
	const claims: AuditResult["claims"] = [];
	const sources = new Map<string, Set<string>>();
	const add = (claim: string, record: string, code: AuditFinding["code"]) => findings.push({ claim, record, code });
	for (const claimId of selected) {
		const claim = records.get(claimId);
		if (!claim) {
			add(claimId, claimId, "missing");
			continue;
		}
		if (claim.kind !== "claim") {
			add(claimId, claimId, "not_claim");
			continue;
		}
		claims.push({ id: claimId, applicability: claim.applicability });
		if (claim.status !== "active") add(claimId, claimId, "inactive");
		if (claim.review) add(claimId, claimId, "review_required");
		if (!claim.refs.length) add(claimId, claimId, "missing_support");
		const relevant = new Set([claimId, ...claim.refs]);
		// Follow reverse concern links, including gaps concerning other selected-scope gaps.
		let grew = true;
		while (grew) {
			grew = false;
			for (const gap of records.values()) {
				if (gap.kind !== "gap" || relevant.has(gap.id) || (gap.status !== "active" && gap.status !== "resolved"))
					continue;
				const concerns = "semantics" in gap ? (gap.concerns ?? []) : gap.status === "active" ? gap.refs : [];
				if (concerns.some((id) => relevant.has(id))) {
					relevant.add(gap.id);
					grew = true;
				}
			}
		}
		const support = new Set(claim.refs);
		for (const id of relevant) {
			const gap = records.get(id);
			if (gap?.kind !== "gap") continue;
			if (gap.status === "active") add(claimId, id, "open_concern");
			if (gap.review) add(claimId, id, "reviewed_concern");
			if ("semantics" in gap) for (const ref of gap.resolvedBy ?? []) support.add(ref);
		}
		for (const id of support) {
			const record = records.get(id);
			if (!record) {
				add(claimId, id, "missing_support");
				continue;
			}
			if (record.kind !== "evidence") {
				add(claimId, id, "not_evidence");
				continue;
			}
			if (record.status !== "active") add(claimId, id, "inactive");
			if (record.review) add(claimId, id, "review_required");
			if (record.source?.kind === "tool") add(claimId, id, "receipt_only");
			else if (record.source?.kind === "file") {
				const users = sources.get(id) ?? new Set<string>();
				users.add(claimId);
				sources.set(id, users);
			} else add(claimId, id, "source_unavailable");
		}
	}
	return { claims, findings, sources, records };
}
