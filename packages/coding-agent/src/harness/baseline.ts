import { type CheckOutcome, DIAGNOSTIC_LINE } from "./checks.ts";

/**
 * Check baselines: what a check reported before the request changed anything, so a failure the
 * project already had does not become the model's job. Without it, a project with existing type
 * or lint errors fails every settle, and each repair round is a full model turn spent on code the
 * request never touched (and a push toward unrelated edits).
 *
 * Errors are compared as keys that survive edits elsewhere: line and column numbers, counts and
 * durations are dropped, and an indented line is keyed under the unindented line above it (the
 * file header in ESLint-style output, the error in tsc-style output). Keys are a multiset, so a
 * second copy of an existing error is new.
 */

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function normalize(line: string): string {
	return (
		line
			.replace(ANSI, "")
			.replace(/\d+/g, "#")
			// Counts change with the errors: "Found 1 error" and "Found 2 errors" are the same line.
			.replace(/#(\s+)(\w+?)s\b/g, "#$1$2")
			.replace(/\s+/g, " ")
			.trim()
	);
}

interface ErrorEntry {
	key: string;
	/** The line as printed, with the header it was keyed under when that differs. */
	text: string;
}

/** The error lines of a check's output, with their comparison keys. */
export function errorEntries(output: string): ErrorEntry[] {
	const entries: ErrorEntry[] = [];
	let header = "";
	for (const raw of output.replace(ANSI, "").split(/\r?\n/)) {
		if (!raw.trim()) continue;
		const indented = /^\s/.test(raw);
		if (!indented) header = raw.trim();
		if (!DIAGNOSTIC_LINE.test(raw)) continue;
		const line = raw.trim();
		entries.push(
			indented && header
				? { key: `${normalize(header)}\0${normalize(line)}`, text: `${header}: ${line}` }
				: { key: normalize(line), text: line },
		);
	}
	return entries;
}

export interface BaselineComparison {
	/** The check fails only with errors it already reported before the request. */
	preexisting: boolean;
	/** Error lines the baseline did not have, in output order. */
	newErrors: string[];
	/** Error lines the baseline had too, left out of the feedback. */
	known: number;
}

/**
 * Compare a failing outcome with the same check's result from the start of the request.
 * Undefined when there is nothing to compare: the check passes now, the baseline passed (every
 * failure is new), or either run says nothing about the code (timeout, spawn error).
 */
export function compareWithBaseline(
	current: CheckOutcome,
	baseline: CheckOutcome | undefined,
): BaselineComparison | undefined {
	if (!baseline || current.passed || baseline.passed || current.timedOut || baseline.timedOut) return undefined;
	// A different exit code is a different failure (a crash where there were errors, say).
	if (current.exitCode === null || current.exitCode !== baseline.exitCode) return undefined;
	const now = errorEntries(current.output);
	const before = errorEntries(baseline.output);
	if (now.length === 0 || before.length === 0) {
		// No recognizable error lines: only an identical report counts as the same failure.
		const same = normalize(current.output) === normalize(baseline.output);
		return same ? { preexisting: true, newErrors: [], known: 0 } : undefined;
	}
	const remaining = new Map<string, number>();
	for (const entry of before) remaining.set(entry.key, (remaining.get(entry.key) ?? 0) + 1);
	const newErrors: string[] = [];
	let known = 0;
	for (const entry of now) {
		const left = remaining.get(entry.key) ?? 0;
		if (left > 0) {
			remaining.set(entry.key, left - 1);
			known++;
		} else newErrors.push(entry.text);
	}
	return { preexisting: newErrors.length === 0, newErrors, known };
}
