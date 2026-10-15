import { type Static, Type } from "typebox";

export const MAX_INPUT_BYTES = 24 * 1024;
export const MAX_LINES = 400;
const MAX_DIAGNOSTICS = 24;
const MAX_EVIDENCE_BYTES = 6000;

export const RangeSchema = Type.Object({ startLine: Type.Integer(), endLine: Type.Integer() });
export type LineRange = Static<typeof RangeSchema>;
export const DiagnosticSchema = Type.Object({
	category: Type.String(),
	code: Type.Union([Type.String(), Type.Null()]),
	message: Type.String(),
	messageTruncated: Type.Boolean(),
	firstLine: Type.Integer(),
	lastLine: Type.Integer(),
	occurrences: Type.Integer(),
});
export type Diagnostic = Static<typeof DiagnosticSchema>;

interface Match {
	category: string;
	code: string | null;
	recognized: boolean;
}

function matchDiagnostic(line: string): Match | undefined {
	const text = line.trim();
	if (/^(?:[✔✓]|ok\b|# Subtest:)/u.test(text)) return;
	if (/^(?:#|ℹ)\s+(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+\d/u.test(text)) return;
	const type = /\berror (TS\d{4,5}):/.exec(text);
	if (type) return { category: "type_error", code: type[1], recognized: true };
	const npm = /^npm (?:error|ERR!) code (E[A-Z0-9_]+)\b/.exec(text);
	if (npm) {
		const code = npm[1];
		const category = ["ERESOLVE", "ETARGET", "EDEPENDENCY"].includes(code)
			? "dependency"
			: ["EACCES", "EPERM", "ENOENT", "ENOTFOUND", "ECONNRESET", "ETIMEDOUT"].includes(code)
				? "environment"
				: "other";
		return { category, code, recognized: category !== "other" };
	}
	if (/^(?:not ok\b|[✖×]\s|FAIL\s)/u.test(text)) return { category: "test_failure", code: null, recognized: true };
	if (/\b(?:error|fail(?:ed|ure)?|exception|fatal|panic|TS\d{4}|ENOENT|EACCES)\b/i.test(text))
		return { category: "other", code: null, recognized: false };
}

export interface LogAnalysis {
	text: string;
	evidence: string;
	scannedRange: LineRange;
	selectedRanges: LineRange[];
	omittedRanges: LineRange[];
	diagnostics: Diagnostic[];
	diagnosticsOmitted: number;
	localReason: string | null;
	localCategory: string | null;
	selectedLineCount: number;
}

function ranges(indexes: number[]): LineRange[] {
	const result: LineRange[] = [];
	for (const index of indexes) {
		const last = result.at(-1);
		if (last && last.endLine === index) last.endLine++;
		else result.push({ startLine: index + 1, endLine: index + 1 });
	}
	return result;
}

function omissions(selected: LineRange[], total: number): LineRange[] {
	const result: LineRange[] = [];
	let next = 1;
	for (const range of selected) {
		if (next < range.startLine) result.push({ startLine: next, endLine: range.startLine - 1 });
		next = range.endLine + 1;
	}
	if (next <= total) result.push({ startLine: next, endLine: total });
	return result;
}

export function analyzeLog(lines: string[], startLine?: number, maxLines = MAX_LINES): LogAnalysis {
	const start = startLine === undefined ? 0 : startLine - 1;
	const end = startLine === undefined ? lines.length : Math.min(lines.length, start + maxLines);
	const groups = new Map<string, Diagnostic>();
	const repeats = new Set<number>();
	let unrecognized = false;
	for (let index = start; index < end; index++) {
		const match = matchDiagnostic(lines[index]);
		if (!match) continue;
		unrecognized ||= !match.recognized;
		const signature = lines[index].trim();
		const previous = groups.get(signature);
		if (previous) {
			repeats.add(index);
			previous.occurrences++;
			previous.lastLine = index + 1;
		} else {
			const message = [...signature].slice(0, 300).join("");
			groups.set(signature, {
				category: match.category,
				code: match.code,
				message,
				messageTruncated: message !== signature,
				firstLine: index + 1,
				lastLine: index + 1,
				occurrences: 1,
			});
		}
	}
	const diagnostics: Diagnostic[] = [];
	let diagnosticBytes = 0;
	for (const diagnostic of groups.values()) {
		const size = Buffer.byteLength(JSON.stringify(diagnostic));
		if (diagnostics.length === MAX_DIAGNOSTICS || diagnosticBytes + size > MAX_EVIDENCE_BYTES) break;
		diagnostics.push(diagnostic);
		diagnosticBytes += size;
	}
	const selected = new Set<number>();
	let bytes = 0;
	const row = (index: number) => `${index + 1}: ${lines[index]}`;
	const add = (index: number): boolean => {
		if (index < start || index >= end || selected.has(index)) return true;
		const size = Buffer.byteLength(row(index)) + (selected.size ? 1 : 0);
		if (selected.size >= maxLines || bytes + size > MAX_INPUT_BYTES) return false;
		selected.add(index);
		bytes += size;
		return true;
	};
	if (startLine !== undefined) {
		for (let index = start; index < end; index++) if (!add(index)) break;
	} else if (lines.length <= maxLines && Buffer.byteLength(lines.map((_, i) => row(i)).join("\n")) <= MAX_INPUT_BYTES) {
		for (let index = start; index < end; index++) add(index);
	} else {
		if (diagnostics.length) add(diagnostics[0].firstLine - 1);
		add(end - 1);
		for (const diagnostic of diagnostics) add(diagnostic.firstLine - 1);
		for (let index = Math.max(start, end - 8); index < end; index++) add(index);
		for (const diagnostic of diagnostics) {
			for (let delta = -2; delta <= 3; delta++) add(diagnostic.firstLine - 1 + delta);
		}
		for (let index = end - 1; index >= start && selected.size < maxLines; index--) {
			if (!repeats.has(index)) add(index);
		}
	}
	if (!selected.size) throw new Error("A selected log line exceeds 24 KiB. Export shorter lines first.");
	const indexes = [...selected].sort((a, b) => a - b);
	const selectedRanges = ranges(indexes);
	const text = indexes.map(row).join("\n");
	const evidenceIndexes = new Set<number>();
	let evidenceBytes = 0;
	const addEvidence = (index: number) => {
		if (!selected.has(index) || evidenceIndexes.has(index)) return;
		const size = Buffer.byteLength(row(index)) + 1;
		if (evidenceIndexes.size >= 24 || evidenceBytes + size > MAX_EVIDENCE_BYTES) return;
		evidenceIndexes.add(index);
		evidenceBytes += size;
	};
	for (const diagnostic of diagnostics) addEvidence(diagnostic.firstLine - 1);
	for (const index of indexes.slice(-8)) addEvidence(index);
	for (const diagnostic of diagnostics) {
		addEvidence(diagnostic.firstLine - 2);
		addEvidence(diagnostic.firstLine);
	}
	const evidence = [...evidenceIndexes]
		.sort((a, b) => a - b)
		.map(row)
		.join("\n");
	const complete = start === 0 && end === lines.length;
	const short =
		selected.size === end - start && text.length <= 3000 && Buffer.byteLength(text) <= 4096 && selected.size <= 24;
	const recognized =
		groups.size > 0 &&
		!unrecognized &&
		groups.size === diagnostics.length &&
		diagnostics.every((item) => !item.messageTruncated && evidenceIndexes.has(item.firstLine - 1));
	const tail = [...evidenceIndexes]
		.filter((index) => index >= end - 12)
		.sort((a, b) => a - b)
		.map((index) => lines[index])
		.join("\n");
	const totals =
		complete &&
		groups.size === 0 &&
		/^(?:#|ℹ)\s+tests [1-9]\d*\s*$/mu.test(tail) &&
		/^(?:#|ℹ)\s+fail 0\s*$/mu.test(tail) &&
		/^(?:#|ℹ)\s+cancelled 0\s*$/mu.test(tail) &&
		/^(?:#|ℹ)\s+duration_ms [\d.]+\s*$/mu.test(tail);
	const localReason = short
		? "short_selection"
		: totals
			? "reported_test_totals"
			: recognized
				? "recognized_diagnostics"
				: null;
	const categories = new Set(diagnostics.map((item) => item.category));
	const localCategory =
		groups.size === diagnostics.length && !unrecognized && categories.size
			? categories.size === 1
				? diagnostics[0].category
				: "mixed"
			: totals
				? "other"
				: null;
	return {
		text,
		evidence: short ? text : evidence || "Evidence lines exceed the display limit; read the local snapshot.",
		scannedRange: { startLine: start + 1, endLine: end },
		selectedRanges,
		omittedRanges: omissions(selectedRanges, lines.length),
		diagnostics,
		diagnosticsOmitted: groups.size - diagnostics.length,
		localReason,
		localCategory,
		selectedLineCount: selected.size,
	};
}
