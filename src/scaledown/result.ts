import { type Static, Type } from "typebox";
import { DiagnosticSchema, RangeSchema } from "./analysis.ts";

const NullableString = Type.Union([Type.String(), Type.Null()]);
const NullableNumber = Type.Union([Type.Number(), Type.Null()]);

/** Identical machine-readable contract for local, cached, remote, and partial/error results. */
export const TriageSchema = Type.Object({
	version: Type.Literal(2),
	advisory: Type.Literal(true),
	warning: Type.String(),
	mode: Type.Union([Type.Literal("local"), Type.Literal("remote"), Type.Literal("cache")]),
	reason: NullableString,
	source: Type.String(),
	snapshot: Type.String(),
	sha256: Type.String(),
	selectionSha256: Type.String(),
	totalLines: Type.Integer(),
	scannedRange: RangeSchema,
	selectedRanges: Type.Array(RangeSchema),
	omittedRanges: Type.Array(RangeSchema),
	selectedLineCount: Type.Integer(),
	selectedBytes: Type.Integer(),
	redacted: Type.Boolean(),
	diagnostics: Type.Array(DiagnosticSchema),
	diagnosticsOmitted: Type.Integer(),
	evidence: Type.String(),
	category: NullableString,
	categorySource: Type.Union([Type.Literal("local"), Type.Literal("provider"), Type.Null()]),
	confidence: NullableNumber,
	summary: NullableString,
	summaryTruncated: Type.Boolean(),
	exitCode: Type.Null(),
	errors: Type.Array(Type.String()),
	requestAttempts: Type.Integer(),
	reportedTokens: NullableNumber,
	reportedCostUsd: NullableNumber,
	completeUsage: Type.Boolean(),
	completeCost: Type.Boolean(),
	providerMs: Type.Number(),
	totalMs: Type.Number(),
});
export type TriageData = Static<typeof TriageSchema>;

export function renderTriage(data: TriageData): string {
	const formatRanges = (ranges: TriageData["selectedRanges"]) =>
		ranges
			.map(({ startLine, endLine }) => (startLine === endLine ? `${startLine}` : `${startLine}–${endLine}`))
			.join(", ") || "none";
	return [
		`ScaleDown log triage — ${data.warning}`,
		`Mode: ${data.mode}${data.reason ? ` (${data.reason})` : ""}; ${data.requestAttempts} new request attempts.`,
		`Source: ${data.source}`,
		`Local full snapshot (may contain secrets; do not upload): ${data.snapshot}\nSnapshot SHA-256: ${data.sha256}`,
		`Locally scanned lines ${formatRanges([data.scannedRange])} of ${data.totalLines}. Selected evidence/upload lines: ${formatRanges(data.selectedRanges)}. Omitted from selection: ${formatRanges(data.omittedRanges)}. Only selected lines reach the provider; a local scan is not exhaustive diagnosis. Exit code is unknown unless independently recorded.`,
		`Credential redaction: ${data.redacted ? "applied" : "no common patterns detected"}; not a guarantee that the text is secret-free.`,
		data.category
			? `Suggested category (${data.categorySource}): ${data.category}${data.confidence === null ? "" : ` (${(data.confidence * 100).toFixed(1)}% relative probability among supplied labels).${data.confidence < 0.7 ? " Low confidence: inspect the original evidence." : ""}`}`
			: "Category unknown; absence of recognized diagnostics does not mean success.",
		data.summary
			? `Generated summary${data.summaryTruncated ? " [TRUNCATED by provider]" : ""}:\n${data.summary}`
			: "No generated summary; use local evidence.",
		`Local diagnostic groups (exact trimmed-line repeats in scanned range; ${data.diagnosticsOmitted} groups omitted):`,
		...data.diagnostics.map(
			(item) =>
				`${item.firstLine}–${item.lastLine}: ${item.occurrences} occurrence(s) · ${item.message}${item.messageTruncated ? " [clipped]" : ""}`,
		),
		"Local evidence (sampled, line-numbered; terminal escapes removed and common credentials redacted):",
		data.evidence,
		...data.errors,
		`This call: ${data.reportedTokens ?? "unknown"} reported helper tokens${data.completeUsage ? "" : " (incomplete)"}; ${data.reportedCostUsd === null ? "unknown cost" : `$${data.reportedCostUsd.toFixed(6)} reported cost`}${data.completeCost ? "" : " (incomplete; unreported charges are not zero)"}. Cache hits never re-add usage. No savings estimate.`,
		`Elapsed: ${data.totalMs} ms total; ${data.providerMs} ms provider wait.`,
	].join("\n\n");
}
