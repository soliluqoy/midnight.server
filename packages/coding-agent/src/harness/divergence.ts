import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/**
 * Divergence: more varied attempts when a model is stuck, and only then.
 *
 * Problem: after a failed repair a model tends to retry the same idea. Repeated attempts on one
 * task are strongly correlated (intra-task correlation 0.51 in the drift pilots,
 * docs/LUNA_DESIGN.md), so a retry that resembles a rejected attempt fails the same way.
 * Example: the checks reject `if (n < 0)`; the next attempt is `if (n <= 0)` in the same place.
 *
 * Solution, borrowed from Lattice-1's search archive and duplicate detection: keep every attempt
 * the checks rejected in this request, fingerprint its change, and measure how close a new failed
 * attempt is to the earlier ones. A near duplicate is named with the measured similarity. While
 * the model is stuck (the same checks failed again, or the attempt repeats a rejected one) it is
 * shown the rejected approaches and asked for causes that differ in kind, and its thinking level
 * goes up one step; the level returns to the user's setting when the run settles.
 */

/** Thinking levels from least to most effort. */
const LADDER: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A boost never goes past this level on its own: above it, cost grows faster than the gain. */
export const BOOST_CEILING: ThinkingLevel = "high";

/** At most this many one-step boosts per request. */
export const MAX_BOOSTS_PER_REQUEST = 2;

/** An attempt at least this similar to a rejected one counts as a repeat of it. */
export const REPEAT_SIMILARITY = 0.8;

/**
 * The level one step above `current`, or undefined when `current` is already at or above the
 * ceiling. From `off` or `minimal` the first step goes to `low`: `minimal` barely reasons.
 */
export function boostedLevel(
	current: ThinkingLevel,
	ceiling: ThinkingLevel = BOOST_CEILING,
): ThinkingLevel | undefined {
	const from = LADDER.indexOf(current);
	const cap = LADDER.indexOf(ceiling);
	if (from < 0 || from >= cap) return undefined;
	return LADDER[Math.min(cap, Math.max(from + 1, LADDER.indexOf("low")))];
}

const TOKEN = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|[^\s\w]/g;

/**
 * The features of a unified diff: each added or removed line becomes its token trigrams, tagged
 * with the side. Whitespace and line position do not count, so re-indenting or moving the same
 * change does not make it new.
 */
export function changeFingerprint(diff: string): Set<string> {
	const features = new Set<string>();
	for (const line of diff.split(/\r?\n/)) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		const sign = line[0];
		if (sign !== "+" && sign !== "-") continue;
		const tokens = line.slice(1).match(TOKEN) ?? [];
		if (tokens.length === 0) continue;
		if (tokens.length < 3) {
			features.add(`${sign}${tokens.join(" ")}`);
			continue;
		}
		for (let index = 0; index + 3 <= tokens.length; index++) {
			features.add(`${sign}${tokens.slice(index, index + 3).join(" ")}`);
		}
	}
	return features;
}

/** Jaccard similarity. Two empty changes are identical: nothing was changed either time. */
export function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 && b.size === 0) return 1;
	let shared = 0;
	for (const feature of a) if (b.has(feature)) shared++;
	return shared / (a.size + b.size - shared);
}

export interface Attempt {
	/** 1-based, in the order the checks rejected them. */
	number: number;
	/** The checks that failed. */
	failed: string[];
	fingerprint: Set<string>;
	/** Files and first added lines, for the list of rejected approaches. */
	summary: string;
}

export interface RecordedAttempt {
	attempt: Attempt;
	/** The most similar earlier attempt, if any. */
	closest?: { attempt: Attempt; similarity: number };
}

const SUMMARY_LINES = 2;
const SUMMARY_LINE_CHARS = 100;

function summarize(diff: string): string {
	const files = [
		...new Set(
			diff
				.split(/\r?\n/)
				.filter((line) => line.startsWith("+++ "))
				.map((line) => line.slice(4).split("\t")[0].replace(/^b\//, ""))
				.filter((path) => path !== "/dev/null"),
		),
	];
	const added = diff
		.split(/\r?\n/)
		.filter((line) => line.startsWith("+") && !line.startsWith("+++") && line.slice(1).trim() !== "")
		.slice(0, SUMMARY_LINES)
		.map((line) => {
			const text = line.slice(1).trim();
			return text.length > SUMMARY_LINE_CHARS ? `${text.slice(0, SUMMARY_LINE_CHARS)}...` : text;
		});
	if (files.length === 0) return "no change to the files";
	return `${files.join(", ")}${added.length > 0 ? `: ${added.map((line) => `\`${line}\``).join("; ")}` : ""}`;
}

/** Every attempt the checks rejected in one request. */
export class ApproachArchive {
	readonly attempts: Attempt[] = [];

	/** Record a rejected attempt: the request's whole change at the moment the checks failed. */
	record(failed: readonly string[], diff: string): RecordedAttempt {
		const fingerprint = changeFingerprint(diff);
		let closest: RecordedAttempt["closest"];
		for (const earlier of this.attempts) {
			const score = similarity(fingerprint, earlier.fingerprint);
			if (!closest || score > closest.similarity) closest = { attempt: earlier, similarity: score };
		}
		const attempt: Attempt = {
			number: this.attempts.length + 1,
			failed: [...failed],
			fingerprint,
			summary: summarize(diff),
		};
		this.attempts.push(attempt);
		return { attempt, closest };
	}
}

/** Whether a recorded attempt repeats an earlier rejected one. */
export function isRepeat(recorded: RecordedAttempt, threshold = REPEAT_SIMILARITY): boolean {
	return recorded.closest !== undefined && recorded.closest.similarity >= threshold;
}

/**
 * Feedback for a stuck model: the measured repeat, if any, the approaches already rejected, and a
 * request for causes that differ in kind before the next edit.
 */
export function divergenceFeedback(
	archive: ApproachArchive,
	recorded: RecordedAttempt,
	threshold = REPEAT_SIMILARITY,
): string {
	const lines: string[] = [];
	if (isRepeat(recorded, threshold) && recorded.closest) {
		const percent = Math.round(recorded.closest.similarity * 100);
		lines.push(
			`This attempt is ${percent}% the same change as attempt ${recorded.closest.attempt.number}, which the checks already rejected (${recorded.closest.attempt.failed.join(", ")}). Repeating it will fail the same way.`,
		);
	}
	lines.push("Approaches the checks rejected in this request:");
	for (const attempt of archive.attempts) lines.push(`${attempt.number}. ${attempt.summary}`);
	lines.push(
		"Before the next edit, name three causes that differ in kind (the input or data format, the control flow or an edge case, the environment or a dependency, a different reading of the request or the test), say what in the output supports or rules out each, and pursue the most likely one that no rejected attempt tried.",
	);
	return lines.join("\n");
}
