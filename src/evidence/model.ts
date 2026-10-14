import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const ENTRY_TYPE = "midnight-evidence-v1";
export const MAX_RECORDS = 512;
export const MAX_RECEIPTS = 128;
const text = Type.String({ minLength: 1, maxLength: 2000 });
const id = Type.String({ minLength: 1, maxLength: 100 });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const refs = Type.Array(id, { maxItems: 16, uniqueItems: true });
export const SourceSchema = Type.Union([
	Type.Object({
		kind: Type.Literal("file"),
		path: Type.String({ maxLength: 4096 }),
		sha256: hash,
		startLine: Type.Integer({ minimum: 1 }),
		endLine: Type.Integer({ minimum: 1 }),
		quote: Type.String({ maxLength: 4000 }),
	}),
	Type.Object({
		kind: Type.Literal("tool"),
		toolCallId: id,
		toolName: Type.String({ maxLength: 100 }),
		parentToolCallId: Type.Optional(id),
		sha256: hash,
		exitCode: Type.Union([Type.Integer(), Type.Null()]),
		advisory: Type.Boolean(),
		// ScaleDown's own source provenance, never its generated summary or log text.
		sourceHash: Type.Optional(hash),
		selectionHash: Type.Optional(hash),
	}),
]);
export const RecordSchema = Type.Object({
	id,
	kind: Type.Union([Type.Literal("evidence"), Type.Literal("claim"), Type.Literal("gap")]),
	text,
	createdAt: Type.String({ maxLength: 40 }),
	status: Type.Union([
		Type.Literal("active"),
		Type.Literal("superseded"),
		Type.Literal("retracted"),
		Type.Literal("resolved"),
	]),
	refs,
	applicability: Type.Union([Type.Literal("historical"), Type.Literal("current")]),
	source: Type.Optional(SourceSchema),
	supersedes: Type.Optional(id),
	reason: Type.Optional(text),
	review: Type.Optional(text),
	automatic: Type.Boolean(),
});
export type EvidenceRecord = Static<typeof RecordSchema>;
export type EvidenceSource = Static<typeof SourceSchema>;
export const EventSchema = Type.Union([
	Type.Object({ version: Type.Literal(1), action: Type.Literal("add"), record: RecordSchema }),
	Type.Object({
		version: Type.Literal(1),
		action: Type.Union([Type.Literal("retract"), Type.Literal("resolve"), Type.Literal("review")]),
		id,
		reason: text,
		refs: Type.Optional(refs),
	}),
]);
export type EvidenceEvent = Static<typeof EventSchema>;
export const SummarySchema = Type.Object({
	evidence: Type.Integer(),
	claims: Type.Integer(),
	review: Type.Integer(),
	gaps: Type.Integer(),
	receipts: Type.Integer(),
	capacityReached: Type.Boolean(),
	invalidEvents: Type.Integer(),
});
export type EvidenceSummary = Static<typeof SummarySchema>;
export const ResultSchema = Type.Object({
	version: Type.Literal(1),
	warning: Type.String(),
	summary: SummarySchema,
	records: Type.Array(RecordSchema),
	total: Type.Integer(),
	nextOffset: Type.Union([Type.Integer(), Type.Null()]),
});

/** Append-only events are the authority; this projection never changes historical entries. */
export class EvidenceLedger {
	readonly records = new Map<string, EvidenceRecord>();
	invalidEvents = 0;

	apply(value: unknown): boolean {
		if (!Value.Check(EventSchema, value)) {
			this.invalidEvents++;
			return false;
		}
		const event = value;
		if (event.action === "add") {
			const record = event.record;
			const old = record.supersedes ? this.records.get(record.supersedes) : undefined;
			if (
				this.records.has(record.id) ||
				this.records.size >= MAX_RECORDS ||
				record.status !== "active" ||
				(record.supersedes && (!old || old.kind !== record.kind || old.status !== "active")) ||
				(record.kind === "evidence" ? !record.source || record.refs.length > 0 : !!record.source) ||
				(record.kind === "claim" && record.refs.length === 0) ||
				record.refs.some((ref) => {
					const target = this.records.get(ref);
					return (
						!target ||
						ref === record.supersedes ||
						target.status !== "active" ||
						(record.kind === "claim" && target.kind !== "evidence")
					);
				})
			)
				return this.invalid();
			if (old) {
				this.records.set(old.id, { ...old, status: "superseded", reason: `Superseded by ${record.id}` });
				this.invalidateDependents(old.id, `Dependency ${old.id} was superseded; reassess using ${record.id}.`);
			}
			const copy = structuredClone(record);
			if (copy.applicability === "current" && copy.refs.some((ref) => this.records.get(ref)?.review))
				copy.review = "A dependency requires review.";
			this.records.set(copy.id, copy);
			return true;
		}
		const record = this.records.get(event.id);
		if (!record || record.status !== "active") return this.invalid();
		if (event.action === "resolve") {
			if (
				record.kind !== "gap" ||
				!event.refs?.length ||
				event.refs.some((ref) => {
					const target = this.records.get(ref);
					return !target || target.kind !== "evidence" || target.status !== "active" || !!target.review;
				})
			)
				return this.invalid();
			this.records.set(record.id, { ...record, status: "resolved", reason: event.reason, refs: event.refs });
		} else if (event.action === "retract") {
			this.records.set(record.id, { ...record, status: "retracted", reason: event.reason });
		} else this.records.set(record.id, { ...record, review: event.reason });
		this.invalidateDependents(record.id, `Dependency ${record.id}: ${event.reason}`, event.action === "review");
		return true;
	}

	private invalid(): false {
		this.invalidEvents++;
		return false;
	}

	private invalidateDependents(id: string, reason: string, currentOnly = false): void {
		// References only point backwards, but use a visited set defensively.
		const pending = [id];
		const seen = new Set<string>();
		while (pending.length) {
			const target = pending.pop();
			if (!target || seen.has(target)) continue;
			seen.add(target);
			for (const record of this.records.values()) {
				if (
					(record.status !== "active" && !(record.kind === "gap" && record.status === "resolved")) ||
					!record.refs.includes(target) ||
					(currentOnly && record.kind === "claim" && record.applicability === "historical")
				)
					continue;
				this.records.set(record.id, { ...record, status: "active", review: reason.slice(0, 2000) });
				pending.push(record.id);
			}
		}
	}

	summary(): EvidenceSummary {
		const active = [...this.records.values()].filter((record) => record.status === "active");
		const receipts = [...this.records.values()].filter((record) => record.automatic).length;
		return {
			evidence: active.filter((record) => record.kind === "evidence").length,
			claims: active.filter((record) => record.kind === "claim" && !record.review).length,
			review: active.filter((record) => !!record.review).length,
			gaps: active.filter((record) => record.kind === "gap").length,
			receipts,
			capacityReached: receipts >= MAX_RECEIPTS || this.records.size >= MAX_RECORDS,
			invalidEvents: this.invalidEvents,
		};
	}
}
