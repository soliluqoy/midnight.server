import { Value } from "typebox/value";
import { AuditResultSchema } from "./audit.ts";
import { EvidenceResultV2Schema } from "./result-v2.ts";

export function formatEvidenceResult(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	if (Value.Check(AuditResultSchema, details))
		return `advisory audit · ${details.available ? `${details.total} findings` : "unavailable"}${details.nextOffset !== null ? " · more" : ""} · not verified`;
	const data = details as Record<string, unknown>;
	if (data.version === 1 && data.summary && typeof data.summary === "object") {
		const { review, gaps } = data.summary as Record<string, unknown>;
		if (validCount(review) && validCount(gaps)) return `${review} review · ${gaps} gaps`;
		return undefined;
	}
	if (!Value.Check(EvidenceResultV2Schema, details)) return undefined;
	if (details.action === "archive") {
		if (!details.archive.complete) return "archive scanning · total unknown";
		if (!details.archive.available) return "archive unavailable · total unknown";
		return `historical · ${details.total ?? "unknown"} records${details.nextOffset !== null ? " · more" : ""}${details.issue ? " · issue" : ""}`;
	}
	const parts: string[] = [];
	if (details.appendUncertain) parts.push("append uncertain · writes locked");
	else if (!details.writable || details.mode === "read-only") parts.push("read-only");
	if ("cancelledAfterAppend" in details && details.cancelledAfterAppend)
		parts.push(details.action === "check" ? "cancelled · committed prefix" : "cancelled after append · committed");
	else if ("committed" in details && details.committed) parts.push("committed");
	if (details.action === "preview")
		parts.push(`preview only · ${details.preview.carried} carry · ${details.preview.omitted.total} omitted`);
	else if (details.action === "recover") parts.push("replayed · no retry");
	if (details.issue) parts.push("issue");
	if (details.summary.capacityReached) parts.push("capacity reached");
	if (details.summary.invalidEvents) parts.push(`${details.summary.invalidEvents} invalid events`);
	parts.push(`${details.summary.review} review · ${details.summary.gaps} gaps`);
	return parts.join(" · ");
}

function validCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
