import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { diffLines } from "diff";

/**
 * Verifier probe: do the checks constrain the lines the model changed?
 *
 * Problem: the repair loop drives every run to green visible checks, so what remains wrong is
 * exactly what those checks cannot see. In the drift pilots 17 of 17 hidden failures passed the
 * visible checks (docs/LUNA_DESIGN.md, section 2). A green run says nothing about lines no test
 * pins down.
 *
 * Example: the model changes `if (n < 0)` to reject negative ports. The tests pass. The harness
 * changes that line to `if (n <= 0)` and runs the related tests again: they still pass. So the
 * tests would also pass a wrong boundary, and "tests pass" is weak evidence for this line.
 *
 * Solution (mutation analysis over the change, LUNA_DESIGN section 4; Lattice-1's evaluator
 * treats the same idea as counterexample search): make a few small mutants of the changed lines,
 * keep those that still parse, run the test-level checks on each, and report the mutants no check
 * noticed. The model is asked to pin the behavior with a focused test or to say it is unverified,
 * not to resample. The measured kill rate had AUC 0.71 for hidden failure on the pilots; it is a
 * signal for where tests are weak, not a failure detector.
 *
 * Mutants are written into the working tree, one at a time, and always restored. Before each
 * write a journal entry records the original and the mutant, so a crash cannot leave a mutant
 * behind: the next session restores any file whose content is still exactly the mutant.
 */

export interface Mutant {
	/** Workspace-relative path. */
	path: string;
	/** 1-based line in the changed file. */
	line: number;
	operator: string;
	/** The line before and after mutation, trimmed. */
	from: string;
	to: string;
	/** The whole file with the mutation applied. */
	content: string;
}

type Language = "c" | "python";

const LANGUAGES: Record<string, Language> = {
	".js": "c",
	".mjs": "c",
	".cjs": "c",
	".jsx": "c",
	".ts": "c",
	".mts": "c",
	".cts": "c",
	".tsx": "c",
	".go": "c",
	".rs": "c",
	".py": "python",
};

export function canMutate(path: string): boolean {
	return extname(path).toLowerCase() in LANGUAGES;
}

interface Rule {
	operator: string;
	pattern: RegExp;
	replace: (match: string) => string;
}

// Binary operators only with spaces on both sides: that excludes generics (`Array<string>`), JSX
// tags, arrows and unary signs, which a text-level swap would turn into a different construct.
const SWAPS: [string, string, string][] = [
	["relational", " <= ", " < "],
	["relational", " >= ", " > "],
	["relational", " < ", " <= "],
	["relational", " > ", " >= "],
	["equality", " === ", " !== "],
	["equality", " !== ", " === "],
	["equality", " == ", " != "],
	["equality", " != ", " == "],
	["logical", " && ", " || "],
	["logical", " || ", " && "],
	["arithmetic", " + ", " - "],
	["arithmetic", " - ", " + "],
	["arithmetic", " * ", " / "],
];

const PYTHON_SWAPS: [string, string, string][] = [
	["relational", " <= ", " < "],
	["relational", " >= ", " > "],
	["relational", " < ", " <= "],
	["relational", " > ", " >= "],
	["equality", " == ", " != "],
	["equality", " != ", " == "],
	["logical", " and ", " or "],
	["logical", " or ", " and "],
	["arithmetic", " + ", " - "],
	["arithmetic", " - ", " + "],
	["arithmetic", " * ", " / "],
];

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rulesFor(language: Language): Rule[] {
	const swaps = language === "python" ? PYTHON_SWAPS : SWAPS;
	const [yes, no] = language === "python" ? ["True", "False"] : ["true", "false"];
	return [
		...swaps.map(([operator, from, to]) => ({
			operator,
			pattern: new RegExp(escapeRegExp(from), "g"),
			replace: () => to,
		})),
		{
			operator: "boolean",
			pattern: new RegExp(`\\b(?:${yes}|${no})\\b`, "g"),
			replace: (m) => (m === yes ? no : yes),
		},
		{
			operator: "constant",
			// An integer literal that is not part of a name, a decimal or an index like `a[0]`.
			pattern: /(?<![\w.$[])\d+(?![\w.])/g,
			replace: (m) => (m === "1" ? "0" : String(Number(m) + 1)),
		},
	];
}

/**
 * The line with string literals and comments blanked out (same length), so operators inside them
 * are never mutated. Approximate: one line at a time, template literals end at the line.
 */
export function maskLine(line: string, language: Language): string {
	let out = "";
	let quote: string | undefined;
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (quote) {
			if (char === "\\") {
				out += "  ";
				index++;
				continue;
			}
			if (char === quote) quote = undefined;
			out += quote ? " " : char;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			out += char;
			continue;
		}
		if (language === "python" ? char === "#" : char === "/" && (line[index + 1] === "/" || line[index + 1] === "*")) {
			return out + " ".repeat(line.length - index);
		}
		out += char;
	}
	return out;
}

/** 1-based numbers of the lines in `after` that the change from `before` added or modified. */
export function changedLines(before: string | undefined, after: string): number[] {
	const lines: number[] = [];
	let line = 1;
	for (const part of diffLines((before ?? "").replace(/\r\n/g, "\n"), after.replace(/\r\n/g, "\n"))) {
		const count = part.count ?? part.value.split("\n").length - (part.value.endsWith("\n") ? 1 : 0);
		if (part.removed) continue;
		if (part.added) for (let offset = 0; offset < count; offset++) lines.push(line + offset);
		line += count;
	}
	return lines;
}

const OPERATOR_ORDER = ["relational", "equality", "logical", "boolean", "arithmetic", "constant"];

/** Every candidate mutant of the changed lines of one file, one mutation site each. */
export function candidateMutants(path: string, before: string | undefined, after: string): Mutant[] {
	const language = LANGUAGES[extname(path).toLowerCase()];
	if (!language) return [];
	const eol = after.includes("\r\n") ? "\r\n" : "\n";
	const lines = after.split(/\r?\n/);
	const rules = rulesFor(language);
	const mutants: Mutant[] = [];
	for (const number of changedLines(before, after)) {
		const text = lines[number - 1];
		if (text === undefined || text.trim() === "") continue;
		// Import lines and declarations of types carry no behavior a test could pin.
		if (/^\s*(?:import|export\s+(?:type|interface)|type|interface|from\s+\S+\s+import)\b/.test(text)) continue;
		const masked = maskLine(text, language);
		for (const rule of rules) {
			for (const match of masked.matchAll(rule.pattern)) {
				const start = match.index ?? 0;
				const original = text.slice(start, start + match[0].length);
				const replacement = rule.replace(original);
				if (replacement === original) continue;
				const mutated = text.slice(0, start) + replacement + text.slice(start + match[0].length);
				const copy = [...lines];
				copy[number - 1] = mutated;
				mutants.push({
					path,
					line: number,
					operator: rule.operator,
					from: text.trim(),
					to: mutated.trim(),
					content: copy.join(eol),
				});
			}
		}
	}
	return mutants;
}

/**
 * Pick at most `max` mutants spread over the changed lines: one per line before a second on any
 * line, and within a line the operators most likely to change behavior first. Deterministic.
 */
export function selectMutants(candidates: readonly Mutant[], max: number): Mutant[] {
	const byLine = new Map<string, Mutant[]>();
	for (const mutant of candidates) {
		const key = `${mutant.path}:${mutant.line}`;
		const list = byLine.get(key) ?? [];
		list.push(mutant);
		byLine.set(key, list);
	}
	for (const list of byLine.values()) {
		list.sort((a, b) => OPERATOR_ORDER.indexOf(a.operator) - OPERATOR_ORDER.indexOf(b.operator));
	}
	const queues = [...byLine.values()];
	const selected: Mutant[] = [];
	const seen = new Set<string>();
	for (let round = 0; selected.length < max && queues.some((queue) => queue.length > round); round++) {
		for (const queue of queues) {
			const mutant = queue[round];
			if (!mutant || selected.length >= max) continue;
			const key = `${mutant.path}\0${mutant.content}`;
			if (seen.has(key)) continue;
			seen.add(key);
			selected.push(mutant);
		}
	}
	return selected;
}

/* ------------------------------------------------------------------------------ journal */

interface JournalEntry {
	cwd: string;
	path: string;
	original: string;
	mutant: string;
	pid: number;
	createdAt: number;
}

/** The journal file of a probe in `cwd` run by process `pid`. */
export function journalName(cwd: string, pid = process.pid): string {
	return `${createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16)}-${pid}.json`;
}

function processAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface RecoveryNote {
	path: string;
	action: "restored" | "already original" | "changed since; left alone";
}

/**
 * Restore files a crashed probe left mutated in `cwd`. A file is restored only when its content is
 * still exactly the mutant; a file changed since is left alone and reported.
 */
export function recoverMutations(journalDir: string, cwd: string): RecoveryNote[] {
	if (!existsSync(journalDir)) return [];
	const prefix = journalName(cwd).split("-")[0];
	const notes: RecoveryNote[] = [];
	for (const name of readdirSync(journalDir)) {
		if (!name.startsWith(`${prefix}-`) || !name.endsWith(".json")) continue;
		const file = join(journalDir, name);
		let entry: JournalEntry;
		try {
			entry = JSON.parse(readFileSync(file, "utf8")) as JournalEntry;
		} catch {
			rmSync(file, { force: true });
			continue;
		}
		// A live probe in another session owns its journal.
		if (entry.pid !== process.pid && processAlive(entry.pid)) continue;
		let current: string | undefined;
		try {
			current = readFileSync(entry.path, "utf8");
		} catch {
			current = undefined;
		}
		if (current === entry.mutant) {
			writeFileSync(entry.path, entry.original);
			notes.push({ path: entry.path, action: "restored" });
		} else if (current === entry.original) {
			notes.push({ path: entry.path, action: "already original" });
		} else {
			notes.push({ path: entry.path, action: "changed since; left alone" });
		}
		rmSync(file, { force: true });
	}
	return notes;
}

/* -------------------------------------------------------------------------------- probe */

export interface ProbeOptions {
	cwd: string;
	/** Where crash-recovery journals live (outside the workspace). */
	journalDir: string;
	mutants: readonly Mutant[];
	/**
	 * Run the test-level checks on the working tree as it is now. Resolves true when every check
	 * passed; a failure or a timeout kills the mutant.
	 */
	runChecks: () => Promise<boolean>;
	/** Parse the mutant's content; false drops it (a mutant that does not parse proves nothing). */
	parses: (mutant: Mutant) => Promise<boolean>;
	/** Stop starting new mutants after this long. */
	budgetMs: number;
	signal?: AbortSignal;
}

export interface ProbeResult {
	/** Mutants that parsed and ran. */
	ran: number;
	killed: number;
	survivors: Mutant[];
	/** Mutants dropped because they did not parse. */
	unparsable: number;
	/** Mutants not run because the time budget ran out. */
	skipped: number;
	elapsedMs: number;
}

/** Run each mutant against the checks, restoring the original after each, and report survivors. */
export async function runProbe(options: ProbeOptions): Promise<ProbeResult> {
	const started = Date.now();
	const parsed = await Promise.all(
		options.mutants.map(async (mutant) => ((await options.parses(mutant)) ? mutant : undefined)),
	);
	const runnable = parsed.filter((mutant): mutant is Mutant => mutant !== undefined);
	const result: ProbeResult = {
		ran: 0,
		killed: 0,
		survivors: [],
		unparsable: options.mutants.length - runnable.length,
		skipped: 0,
		elapsedMs: 0,
	};
	mkdirSync(options.journalDir, { recursive: true });
	const journal = join(options.journalDir, journalName(options.cwd));
	for (const mutant of runnable) {
		if (options.signal?.aborted || Date.now() - started > options.budgetMs) {
			result.skipped++;
			continue;
		}
		const path = resolve(options.cwd, mutant.path);
		let original: string;
		try {
			original = readFileSync(path, "utf8");
		} catch {
			result.skipped++;
			continue;
		}
		const entry: JournalEntry = {
			cwd: resolve(options.cwd),
			path,
			original,
			mutant: mutant.content,
			pid: process.pid,
			createdAt: Date.now(),
		};
		writeFileSync(journal, JSON.stringify(entry));
		let passed: boolean;
		try {
			writeFileSync(path, mutant.content);
			passed = await options.runChecks();
		} finally {
			writeFileSync(path, original);
			rmSync(journal, { force: true });
		}
		if (options.signal?.aborted) {
			result.skipped++;
			continue;
		}
		result.ran++;
		if (passed) result.survivors.push(mutant);
		else result.killed++;
	}
	result.elapsedMs = Date.now() - started;
	return result;
}

/** The message for the model when some mutants survived. */
export function formatProbeFeedback(result: ProbeResult, checks: readonly string[]): string {
	const lines = [
		`Verifier probe: the harness made ${result.ran} small change(s) to lines you changed and reran the tests (${checks.join(", ")}). ${result.killed} were caught; ${result.survivors.length} were not:`,
	];
	for (const mutant of result.survivors) {
		lines.push(`- ${mutant.path}:${mutant.line} (${mutant.operator}): \`${mutant.from}\` -> \`${mutant.to}\``);
	}
	lines.push(
		"The tests pass with these wrong versions too, so they do not show that this behavior is right. For each line the request depends on, add a focused test that fails on the changed version (do not edit protected tests). If the line does not matter, the change is equivalent, or it cannot be tested, say so in your final message. Do not call these behaviors verified.",
	);
	return lines.join("\n");
}
