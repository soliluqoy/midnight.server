import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import { spawnProcess, waitForChildProcess } from "../utils/child-process.ts";
import { killProcessTree } from "../utils/shell.ts";
import type { BaselineComparison } from "./baseline.ts";
import type { HarnessCheck } from "./config.ts";

/** Workspace-relative, forward-slash path, or undefined when `path` is outside `cwd`. */
export function workspaceRelative(cwd: string, path: string): string | undefined {
	const rel = relative(cwd, resolve(cwd, path));
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
	return rel.split(sep).join("/");
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
	return globs.some((glob) => minimatch(path, glob, { dot: true, nocase: process.platform === "win32" }));
}

export interface SelectedCheck {
	check: HarnessCheck;
	/** Changed files that matched `when`; empty for checks without `when`. */
	files: string[];
	/** Final argv when the caller already expanded placeholders such as `{tests}`. */
	argv?: string[];
}

/** The checks a set of changed files calls for, with `{files}` resolved per check. */
export function selectChecks(checks: readonly HarnessCheck[], changed: readonly string[]): SelectedCheck[] {
	if (changed.length === 0) return [];
	return checks.flatMap((check) => {
		if (!check.when) return [{ check, files: [] }];
		const files = changed.filter((path) => matchesAny(path, check.when ?? []));
		return files.length > 0 ? [{ check, files }] : [];
	});
}

export function expandCommand(command: readonly string[], files: readonly string[]): string[] {
	return command.flatMap((arg) => (arg === "{files}" ? [...files] : [arg]));
}

export interface CheckOutcome {
	name: string;
	argv: string[];
	passed: boolean;
	exitCode: number | null;
	timedOut: boolean;
	elapsedMs: number;
	/** stdout and stderr interleaved, byte-capped. */
	output: string;
	truncated: boolean;
	/** Set on a failure compared with the same check's result from the start of the request. */
	baseline?: BaselineComparison;
}

/** A failure the model has to deal with: not one the project already had before the request. */
export function blocks(outcome: CheckOutcome): boolean {
	return !outcome.passed && !outcome.baseline?.preexisting;
}

const CHECK_MAX_OUTPUT_BYTES = 64_000;

/**
 * Run one check: argv only (no shell), in the workspace, with a timeout and a byte cap.
 * On Windows `spawnProcess` resolves `.cmd` shims such as `npm` and `npx`.
 */
export async function runCheck(selected: SelectedCheck, cwd: string, signal: AbortSignal): Promise<CheckOutcome> {
	const argv = selected.argv ?? expandCommand(selected.check.command, selected.files);
	const started = Date.now();
	const chunks: Buffer[] = [];
	let bytes = 0;
	let truncated = false;
	let timedOut = false;
	let exitCode: number | null = null;
	let spawnError: string | undefined;
	try {
		const child = spawnProcess(argv[0], argv.slice(1), {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			env: selected.check.env ? { ...process.env, ...selected.check.env } : undefined,
		});
		const onData = (data: Buffer) => {
			if (truncated) return;
			const room = CHECK_MAX_OUTPUT_BYTES - bytes;
			if (data.length > room) {
				if (room > 0) chunks.push(data.subarray(0, room));
				bytes = CHECK_MAX_OUTPUT_BYTES;
				truncated = true;
				return;
			}
			chunks.push(data);
			bytes += data.length;
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		const kill = () => {
			if (child.pid) killProcessTree(child.pid);
		};
		const timer =
			selected.check.timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						kill();
					}, selected.check.timeoutMs)
				: undefined;
		if (signal.aborted) kill();
		else signal.addEventListener("abort", kill, { once: true });
		try {
			exitCode = await waitForChildProcess(child);
		} finally {
			if (timer) clearTimeout(timer);
			signal.removeEventListener("abort", kill);
		}
	} catch (error) {
		spawnError = error instanceof Error ? error.message : String(error);
	}
	const output = spawnError ?? Buffer.concat(chunks).toString("utf8");
	return {
		name: selected.check.name,
		argv,
		passed: !spawnError && !timedOut && exitCode === 0,
		exitCode,
		timedOut,
		elapsedMs: Date.now() - started,
		output,
		truncated,
	};
}

const FEEDBACK_HEAD_BYTES = 1_500;
const FEEDBACK_TAIL_BYTES = 4_500;
const DIAGNOSTIC_MAX_BYTES = 2_400;
export const DIAGNOSTIC_LINE =
	/(?:error|fail(?:ed|ure)?|expect(?:ed)?|received|assert|traceback|exception|panic|cannot find|not found|undefined|null)/i;

/**
 * Keep the start (the command's banner and first error) and the end (the summary and the
 * last errors) of long output. Compilers and test runners put the most useful lines there.
 */
export function boundOutput(text: string, head = FEEDBACK_HEAD_BYTES, tail = FEEDBACK_TAIL_BYTES): string {
	const full = Buffer.from(text.trim(), "utf8");
	if (full.length <= head + tail) return full.toString("utf8");
	const omitted = full.length - head - tail;
	return `${full.subarray(0, head).toString("utf8")}\n[... ${omitted} bytes omitted ...]\n${full.subarray(full.length - tail).toString("utf8")}`;
}

/** Extract likely diagnostic lines that may be in the middle of a long test or compiler log. */
export function diagnosticExcerpt(text: string, maxBytes = DIAGNOSTIC_MAX_BYTES): string {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line, index, all) => line.length > 0 && DIAGNOSTIC_LINE.test(line) && all.indexOf(line) === index);
	if (lines.length === 0) return "";
	const output: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		const nextBytes = Buffer.byteLength(line, "utf8") + (output.length > 0 ? 1 : 0);
		if (bytes + nextBytes > maxBytes) break;
		output.push(line);
		bytes += nextBytes;
	}
	return output.join("\n");
}

function describeOutcome(outcome: CheckOutcome): string {
	const status = outcome.timedOut ? "timed out" : `exit ${outcome.exitCode ?? "?"}`;
	const mark = outcome.passed ? "[pass]" : outcome.baseline?.preexisting ? "[known]" : "[FAIL]";
	const line = `${mark} ${outcome.name}: ${outcome.argv.join(" ")} (${status}, ${(outcome.elapsedMs / 1000).toFixed(1)} s)`;
	return outcome.baseline?.preexisting
		? `${line}: fails only with errors it already reported before this request; leave them unless the user asked`
		: line;
}

const NEW_ERRORS_MAX_BYTES = 4_000;

/** The errors a failure added over its baseline, byte-capped, with how many known ones were left out. */
function newErrorsBlock(comparison: BaselineComparison): string[] {
	const lines: string[] = [];
	let bytes = 0;
	let omitted = 0;
	for (const line of comparison.newErrors) {
		const size = Buffer.byteLength(line, "utf8") + 1;
		if (bytes + size > NEW_ERRORS_MAX_BYTES) {
			omitted++;
			continue;
		}
		lines.push(line);
		bytes += size;
	}
	if (omitted > 0) lines.push(`[... ${omitted} more new error lines]`);
	const block = ["<new-errors>", ...lines, "</new-errors>"];
	if (comparison.known > 0) {
		block.push(
			`${comparison.known} error line(s) this check already reported before this request are left out; they are not yours to fix.`,
		);
	}
	return block;
}

/**
 * The message a failed round sends back to the model. On a repeated failure of the same
 * checks it asks for a diagnosis before another edit: retrying the same fix is the common
 * failure after a first repair misses, and naming competing causes breaks that loop.
 */
/**
 * Added to failing-check feedback when the blocker rule is on. Without it, "fix the cause, do not
 * weaken the tests" leaves a model facing a test that contradicts the request two ways out, both
 * drift: undo the requested behavior, or special-case the test (seen in evals/drift pilot-01).
 */
export const REQUEST_WINS_NOTE =
	"If a failing test contradicts what the user asked for, the request wins: keep the requested behavior, do not special-case the test's inputs, and say in your final message which test conflicts and why.";

export function formatCheckFeedback(
	outcomes: readonly CheckOutcome[],
	round: number,
	maxRounds: number,
	repeated: boolean,
	requestWins = false,
	adaptiveRepair = true,
	divergence?: string,
): string {
	const lines = [`Harness checks failed after your changes (repair round ${round} of ${maxRounds}).`];
	for (const outcome of outcomes) {
		lines.push(describeOutcome(outcome));
		if (outcome.baseline && !outcome.baseline.preexisting) lines.push(...newErrorsBlock(outcome.baseline));
		else if (blocks(outcome)) {
			const output = boundOutput(outcome.output) || "(no output)";
			lines.push("<output>", output, "</output>");
			if (Buffer.byteLength(outcome.output, "utf8") > FEEDBACK_HEAD_BYTES + FEEDBACK_TAIL_BYTES) {
				const diagnostics = diagnosticExcerpt(outcome.output);
				if (diagnostics) lines.push("<diagnostic-lines>", diagnostics, "</diagnostic-lines>");
			}
		}
	}
	if (divergence) {
		// Divergence (divergence.ts) asks for causes that differ in kind, so it replaces the
		// two-hypothesis request instead of adding a second one.
		if (repeated && adaptiveRepair) {
			lines.push(
				"The same checks failed again after your last fix. Treat the previous approach as rejected: do not make a cosmetic edit or repeat the same hypothesis.",
			);
		}
		lines.push(divergence);
		if (adaptiveRepair) lines.push("Choose a materially different repair or report the blocker.");
	} else if (repeated && adaptiveRepair) {
		lines.push(
			"The same checks failed again after your last fix. Treat the previous approach as rejected: do not make a cosmetic edit or repeat the same hypothesis. Before editing, state the most likely root cause and one alternative explanation, then check which one the output supports. Choose a materially different repair or report the blocker.",
		);
	} else if (repeated) {
		lines.push(
			"The same checks failed again after your last fix. Before editing, state the most likely root cause and one alternative explanation, then check which one the output supports.",
		);
	}
	lines.push("Fix the cause, then finish. Do not weaken, skip or delete the checks or the tests they run.");
	if (requestWins) lines.push(REQUEST_WINS_NOTE);
	return lines.join("\n");
}

export function formatCheckSummary(outcomes: readonly CheckOutcome[]): string {
	return outcomes.map(describeOutcome).join("\n");
}

/** Mtime-based filter for files git reports as changed, used when a shell tool may have edited them. */
export async function filesModifiedSince(cwd: string, paths: readonly string[], sinceMs: number): Promise<string[]> {
	const modified: string[] = [];
	for (const path of paths) {
		try {
			if ((await stat(resolve(cwd, path))).mtimeMs >= sinceMs) modified.push(path);
		} catch {
			// Deleted files count as changed too.
			modified.push(path);
		}
	}
	return modified;
}

/** Paths in `git status --porcelain=v1 -z` output. Renames report the new path. */
export function parsePorcelainZ(output: string): string[] {
	const fields = output.split("\0");
	const paths: string[] = [];
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index];
		if (field.length < 4) continue;
		const code = field.slice(0, 2);
		paths.push(field.slice(3));
		// A rename or copy is followed by the source path as its own field.
		if (code.includes("R") || code.includes("C")) index++;
	}
	return paths;
}
