import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { EvidenceLedger, type EvidenceRecord, RecordSchema } from "./model.ts";

const closed = { additionalProperties: false };
const id = Type.String({ minLength: 1, maxLength: 100 });
const refs = Type.Array(id, { maxItems: 16, uniqueItems: true });
const explanation = Type.String({ minLength: 1, maxLength: 2000 });
export const ReviewCodeSchema = Type.Union([
	Type.Literal("source_changed"),
	Type.Literal("source_unavailable"),
	Type.Literal("dependency_superseded"),
	Type.Literal("dependency_retracted"),
	Type.Literal("dependency_review"),
	Type.Literal("possible_worktree_change"),
	Type.Literal("session_reloaded"),
	Type.Literal("branch_changed"),
	Type.Literal("legacy_unspecified"),
]);
export const ReviewReasonSchema = Type.Object(
	{ code: ReviewCodeSchema, explanation, dependency: Type.Optional(id) },
	closed,
);
export type ReviewReason = Static<typeof ReviewReasonSchema>;
export const MAX_REVIEW_REASONS = 8;
export const SemanticRecordSchema = Type.Object(
	{
		...RecordSchema.properties,
		semantics: Type.Literal(3),
		concerns: Type.Optional(refs),
		resolvedBy: Type.Optional(refs),
		reviewReasons: Type.Array(ReviewReasonSchema, { maxItems: MAX_REVIEW_REASONS }),
		reviewOverflow: Type.Boolean(),
	},
	closed,
);
export type SemanticRecord = Static<typeof SemanticRecordSchema>;
export const SemanticEventSchema = Type.Union([
	Type.Object({ version: Type.Literal(3), action: Type.Literal("add"), record: SemanticRecordSchema }, closed),
	Type.Object({ version: Type.Literal(3), action: Type.Literal("review"), id, reason: ReviewReasonSchema }, closed),
	Type.Object({ version: Type.Literal(3), action: Type.Literal("retract"), id, reason: explanation }, closed),
	Type.Object(
		{ version: Type.Literal(3), action: Type.Literal("resolve"), id, reason: explanation, resolvedBy: refs },
		closed,
	),
]);
export type SemanticEvent = Static<typeof SemanticEventSchema>;

function dependencies(record: SemanticRecord): string[] {
	return record.kind === "gap" ? [...new Set([...(record.concerns ?? []), ...(record.resolvedBy ?? [])])] : record.refs;
}
function reviewed(record: SemanticRecord, reason: ReviewReason): SemanticRecord {
	const reasons = [...record.reviewReasons];
	const duplicate = reasons.some(
		(r) => r.code === reason.code && r.dependency === reason.dependency && r.explanation === reason.explanation,
	);
	const overflow = !duplicate && reasons.length >= MAX_REVIEW_REASONS;
	if (!duplicate && !overflow) reasons.push(structuredClone(reason));
	return {
		...record,
		review: record.review ?? reason.explanation,
		reviewReasons: reasons,
		reviewOverflow: record.reviewOverflow || overflow,
	};
}

export class SemanticLedger {
	readonly records = new Map<string, SemanticRecord>();

	apply(value: unknown): boolean {
		if (!Value.Check(SemanticEventSchema, value)) return false;
		const event = value;
		const before = this.records;
		const next = new Map([...before].map(([id, record]) => [id, structuredClone(record)]));
		const legacy = new EvidenceLedger();
		for (const [id, record] of next) legacy.records.set(id, record);
		let changed: string;
		let cause: ReviewReason | undefined;
		let currentOnly = false;
		if (event.action === "add") {
			const record = event.record;
			if (record.review || record.reviewReasons.length || record.reviewOverflow || record.resolvedBy?.length)
				return false;
			if (record.kind !== "gap" && (record.concerns !== undefined || record.resolvedBy !== undefined)) return false;
			if (record.kind === "gap" && (record.concerns === undefined || !sameRefs(record.refs, record.concerns)))
				return false;
			if (!legacy.apply({ version: 1, action: "add", record })) return false;
			next.set(record.id, structuredClone(record));
			if (record.supersedes) {
				const old = legacy.records.get(record.supersedes);
				if (!old) return false;
				next.set(old.id, old as SemanticRecord);
			}
			let added = next.get(record.id) as SemanticRecord;
			for (const ref of record.refs) {
				if (record.applicability === "current" && before.get(ref)?.review)
					added = reviewed(added, {
						code: "dependency_review",
						dependency: ref,
						explanation: "A dependency requires reassessment.",
					});
			}
			next.set(record.id, added);
			changed = record.supersedes ?? record.id;
			if (record.supersedes)
				cause = {
					code: "dependency_superseded",
					dependency: changed,
					explanation: `Dependency ${changed} was superseded; reassess explicitly.`,
				};
		} else {
			const record = next.get(event.id);
			if (!record || record.status !== "active") return false;
			changed = record.id;
			if (event.action === "resolve") {
				if (record.kind !== "gap" || !event.resolvedBy.length) return false;
				if (
					!legacy.apply({ version: 1, action: "resolve", id: event.id, reason: event.reason, refs: event.resolvedBy })
				)
					return false;
				const resolved = {
					...record,
					status: "resolved" as const,
					reason: event.reason,
					resolvedBy: [...event.resolvedBy],
				};
				resolved.refs = dependencies(resolved);
				if (resolved.refs.length > 16 || reaches(next, resolved.refs, record.id)) return false;
				next.set(record.id, resolved);
				cause = {
					code: "dependency_review",
					dependency: changed,
					explanation: `Dependency ${changed} was resolved; reassess dependent interpretations.`,
				};
			} else if (event.action === "retract") {
				next.set(record.id, { ...record, status: "retracted", reason: event.reason });
				cause = {
					code: "dependency_retracted",
					dependency: changed,
					explanation: `Dependency ${changed} was retracted: ${event.reason}`.slice(0, 2000),
				};
			} else {
				next.set(record.id, reviewed(record, event.reason));
				cause = { code: "dependency_review", dependency: changed, explanation: event.reason.explanation };
				currentOnly = true;
			}
		}
		if (cause) {
			const pending = [changed];
			const seen = new Set<string>();
			while (pending.length) {
				const target = pending.pop();
				if (!target || seen.has(target)) continue;
				seen.add(target);
				for (const record of next.values()) {
					if (
						!dependencies(record).includes(target) ||
						(record.status !== "active" && !(record.kind === "gap" && record.status === "resolved"))
					)
						continue;
					if (currentOnly && record.kind === "claim" && record.applicability === "historical") continue;
					next.set(record.id, reviewed({ ...record, status: "active" }, { ...cause, dependency: target }));
					pending.push(record.id);
				}
			}
		}
		if ([...next.values()].some((record) => !Value.Check(SemanticRecordSchema, record))) return false;
		this.records.clear();
		for (const [id, record] of next) this.records.set(id, record);
		return true;
	}
}

function sameRefs(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((id) => b.includes(id));
}
function reaches(records: Map<string, SemanticRecord>, roots: string[], target: string): boolean {
	const pending = [...roots];
	const seen = new Set<string>();
	while (pending.length) {
		const id = pending.pop();
		if (!id || seen.has(id)) continue;
		if (id === target) return true;
		seen.add(id);
		pending.push(...(records.get(id)?.refs ?? []));
	}
	return false;
}

export function legacyReviewReason(record: EvidenceRecord): ReviewReason | undefined {
	return record.review ? { code: "legacy_unspecified", explanation: record.review } : undefined;
}
