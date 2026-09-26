import { normalizeForFuzzyMatch } from "../core/tools/edit-diff.ts";

/**
 * Edit repairs and hints for the most common failed edit: `oldText` not found.
 *
 * The edit tool already tolerates trailing whitespace and Unicode quotes. Two cases remain
 * that cost a fast model a read turn and a retry each time:
 *
 * 1. Indentation differs (the model re-indented the snippet it copied, or used spaces for
 *    tabs). When exactly one place in the file matches line by line with leading whitespace
 *    ignored, that place is what the model meant. The repair rewrites `oldText` to the file's
 *    real text and shifts `newText` by the same indentation, before the edit runs.
 * 2. The text differs in content. Then no repair is safe, but the closest block in the file
 *    tells the model exactly what to copy, without another `read`.
 */

export interface TextEdit {
	oldText: string;
	newText: string;
}

function lines(text: string): string[] {
	return text.replace(/\r\n/g, "\n").split("\n");
}

function leadingWhitespace(line: string): string {
	return /^[ \t]*/.exec(line)?.[0] ?? "";
}

function trimLines(block: readonly string[]): string[] {
	const result = block.map((line) => line.trim());
	while (result.length > 0 && result[0] === "") result.shift();
	while (result.length > 0 && result[result.length - 1] === "") result.pop();
	return result;
}

/** True when the edit tool would find `oldText` (exactly or with its own normalization). */
export function editTextFound(content: string, oldText: string): boolean {
	const normalized = content.replace(/\r\n/g, "\n");
	const old = oldText.replace(/\r\n/g, "\n");
	return normalized.includes(old) || normalizeForFuzzyMatch(normalized).includes(normalizeForFuzzyMatch(old));
}

/** Start indexes (0-based lines) where `needle` matches `haystack` with each line trimmed. */
function findTrimmedMatches(haystack: readonly string[], needle: readonly string[]): number[] {
	const trimmedHaystack = haystack.map((line) => line.trim());
	const matches: number[] = [];
	if (needle.length === 0) return matches;
	for (let start = 0; start + needle.length <= haystack.length; start++) {
		let ok = true;
		for (let offset = 0; offset < needle.length; offset++) {
			if (trimmedHaystack[start + offset] !== needle[offset]) {
				ok = false;
				break;
			}
		}
		if (ok) matches.push(start);
	}
	return matches;
}

/**
 * Re-indent `newText` to the file's style. Each indentation string seen in the model's
 * `oldText` maps to the file's indentation on the same line (two spaces -> one tab, and so
 * on), so nested lines keep their relative depth. Lines with an unseen indentation keep it
 * with the first line's prefix swapped.
 */
function reindent(text: string, oldLines: readonly string[], actualLines: readonly string[]): string {
	const map = new Map<string, string>();
	const firstOld = oldLines.findIndex((line) => line.trim() !== "");
	let actualIndex = actualLines.findIndex((line) => line.trim() !== "");
	for (let index = Math.max(0, firstOld); index < oldLines.length && actualIndex < actualLines.length; index++) {
		if (oldLines[index].trim() === "") continue;
		const from = leadingWhitespace(oldLines[index]);
		if (!map.has(from)) map.set(from, leadingWhitespace(actualLines[actualIndex]));
		actualIndex++;
		while (actualIndex < actualLines.length && actualLines[actualIndex].trim() === "") actualIndex++;
	}
	const baseFrom = firstOld >= 0 ? leadingWhitespace(oldLines[firstOld]) : "";
	const baseTo = map.get(baseFrom) ?? baseFrom;
	return lines(text)
		.map((line) => {
			if (line.trim() === "") return line;
			const indent = leadingWhitespace(line);
			const mapped = map.get(indent);
			if (mapped !== undefined) return mapped + line.slice(indent.length);
			if (indent.startsWith(baseFrom)) return baseTo + line.slice(baseFrom.length);
			return line;
		})
		.join("\n");
}

/**
 * Repair an edit whose `oldText` differs from the file only in indentation. Returns the
 * repaired edit, or undefined when the edit already matches, matches nowhere, or matches
 * in more than one place.
 */
export function repairIndentation(content: string, edit: TextEdit): TextEdit | undefined {
	if (editTextFound(content, edit.oldText)) return undefined;
	const fileLines = lines(content);
	const oldLines = lines(edit.oldText);
	const needle = trimLines(oldLines);
	if (needle.length === 0 || needle.every((line) => line === "")) return undefined;
	const matches = findTrimmedMatches(fileLines, needle);
	if (matches.length !== 1) return undefined;
	const start = matches[0];
	const actual = fileLines.slice(start, start + needle.length);
	return { oldText: actual.join("\n"), newText: reindent(edit.newText, oldLines, actual) };
}

function similarity(a: readonly string[], b: readonly string[]): number {
	// Share of lines in `a` that appear (trimmed) in `b`, plus a small bonus for token overlap.
	if (a.length === 0) return 0;
	const set = new Map<string, number>();
	for (const line of b) set.set(line, (set.get(line) ?? 0) + 1);
	let same = 0;
	for (const line of a) {
		const count = set.get(line) ?? 0;
		if (count > 0) {
			same++;
			set.set(line, count - 1);
		}
	}
	const tokensA = new Set(a.join(" ").split(/\W+/).filter(Boolean));
	const tokensB = new Set(b.join(" ").split(/\W+/).filter(Boolean));
	let shared = 0;
	for (const token of tokensA) if (tokensB.has(token)) shared++;
	const tokenScore = tokensA.size > 0 ? shared / tokensA.size : 0;
	return same / a.length + 0.5 * tokenScore;
}

/**
 * The block of the file most like `oldText`, with 1-based line numbers, for a hint after a
 * failed edit. Undefined when nothing is similar enough to be useful.
 */
export function closestBlock(
	content: string,
	oldText: string,
	maxLines = 30,
): { startLine: number; endLine: number; text: string } | undefined {
	const fileLines = lines(content);
	const needle = trimLines(lines(oldText));
	if (needle.length === 0 || fileLines.length === 0) return undefined;
	const size = Math.min(needle.length, fileLines.length);
	const trimmedFile = fileLines.map((line) => line.trim());
	let best = { score: 0, start: -1 };
	for (let start = 0; start + size <= fileLines.length; start++) {
		const score = similarity(needle, trimmedFile.slice(start, start + size));
		if (score > best.score) best = { score, start };
	}
	if (best.start < 0 || best.score < 0.35) return undefined;
	const end = Math.min(fileLines.length, best.start + Math.min(size, maxLines));
	return { startLine: best.start + 1, endLine: end, text: fileLines.slice(best.start, end).join("\n") };
}

export function notFoundHint(path: string, content: string, oldText: string): string | undefined {
	const block = closestBlock(content, oldText);
	if (!block) return undefined;
	return [
		`[harness: the closest text in ${path} is lines ${block.startLine}-${block.endLine}. Copy oldText from it exactly (it is the file's current content):]`,
		block.text,
	].join("\n");
}

function editDistance(a: string, b: string, limit: number): number {
	if (Math.abs(a.length - b.length) > limit) return limit + 1;
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			current.push(value);
			rowMin = Math.min(rowMin, value);
		}
		if (rowMin > limit) return limit + 1;
		previous = current;
	}
	return previous[b.length];
}

/**
 * Workspace files the model probably meant when `requested` does not exist: same file name
 * elsewhere, a near-miss name, or the same name with another extension.
 */
export function suggestPaths(requested: string, files: readonly string[], max = 3): string[] {
	const wanted = requested.replace(/\\/g, "/").replace(/^\.\//, "");
	const name = wanted.split("/").pop() ?? wanted;
	const lowerName = name.toLowerCase();
	const stem = lowerName.replace(/\.[^.]+$/, "");
	const scored: Array<{ path: string; score: number }> = [];
	for (const path of files) {
		const base = (path.split("/").pop() ?? path).toLowerCase();
		let score: number | undefined;
		if (path.toLowerCase() === wanted.toLowerCase()) score = 0;
		else if (base === lowerName) score = 1;
		else if (path.toLowerCase().endsWith(`/${wanted.toLowerCase()}`)) score = 1;
		else if (base.replace(/\.[^.]+$/, "") === stem) score = 2;
		else {
			const distance = editDistance(base, lowerName, 2);
			if (distance <= 2) score = 2 + distance;
		}
		if (score !== undefined) scored.push({ path, score });
	}
	scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length);
	return scored.slice(0, max).map((item) => item.path);
}

/** Shell tools: their results depend on state the guard cannot see, so identical calls are not loops. */
const SHELL_TOOLS = new Set(["bash", "powershell"]);

/**
 * A failure's output with what changes between identical runs removed (numbers such as
 * timings, the shell tool's truncation note with its temporary file), so the same error
 * compares equal.
 */
export function failureSignature(output: string): string {
	return output
		.replace(/\[Showing [^\]]*Full output: [^\]]*\]/g, "")
		.replace(/\d+(?:\.\d+)?/g, "#")
		.replace(/\s+/g, " ")
		.trim()
		.slice(-4_000);
}

/**
 * Notices repeated identical tool calls and repeated identical failing commands within one
 * run. Weak models loop: they re-read the same file or rerun the same failing command,
 * expecting a different result.
 *
 * A fix-and-retest cycle is not a loop: a possible file change (an edit, or a shell command
 * that succeeded) resets the counters, and a failure counts as repeated only when it fails
 * with the same error as the time before.
 */
export class LoopGuard {
	private readonly calls = new Map<string, number>();
	private readonly failures = new Map<string, { count: number; signature: string }>();
	/** Paths edited since the counters started; re-reading an edited file is not a loop. */
	private epoch = 0;
	loops = 0;

	reset(): void {
		this.calls.clear();
		this.failures.clear();
		this.loops = 0;
	}

	/** A file changed: reads of it are new information again, and a rerun tests new code. */
	noteChange(): void {
		this.epoch++;
		this.calls.clear();
		this.failures.clear();
	}

	/**
	 * Earlier results left the model's context (masked or compacted): calling again to see
	 * them is not a loop.
	 */
	forgetCalls(): void {
		this.calls.clear();
	}

	/** Record a call; returns a note when it repeats an earlier identical call. */
	call(toolName: string, input: unknown): string | undefined {
		if (toolName === "task" || toolName === "edit" || toolName === "write" || SHELL_TOOLS.has(toolName)) {
			return undefined;
		}
		const key = `${this.epoch}\0${toolName}\0${JSON.stringify(input)}`;
		const count = (this.calls.get(key) ?? 0) + 1;
		this.calls.set(key, count);
		if (count < 2) return undefined;
		this.loops++;
		return `[harness: this is call ${count} of this exact ${toolName} with the same arguments since the last file change; the result is the same as before. Use the earlier result or try a different approach.]`;
	}

	/**
	 * Record a failed shell command and its output; returns a note when it failed the same way
	 * the time before, with no file edited in between.
	 */
	failure(command: string, output: string): string | undefined {
		const signature = failureSignature(output);
		const previous = this.failures.get(command);
		const count = previous?.signature === signature ? previous.count + 1 : 1;
		this.failures.set(command, { count, signature });
		if (count < 2) return undefined;
		this.loops++;
		return `[harness: this command has failed ${count} times in a row with the same error, with no edit or other successful command in between. Rerunning it unchanged will fail again. Read the error, change the code or the command, or explain the blocker.]`;
	}
}
