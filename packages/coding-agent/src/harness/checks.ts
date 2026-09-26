import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import { spawnProcess, waitForChildProcess } from "../utils/child-process.ts";
import { killProcessTree } from "../utils/shell.ts";
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
}

const CHECK_MAX_OUTPUT_BYTES = 64_000;

/**
 * Run one check: argv only (no shell), in the workspace, with a timeout and a byte cap.
 * On Windows `spawnProcess` resolves `.cmd` shims such as `npm` and `npx`.
 */
export async function runCheck(selected: SelectedCheck, cwd: string, signal: AbortSignal): Promise<CheckOutcome> {
	const argv = expandCommand(selected.check.command, selected.files);
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

function describeOutcome(outcome: CheckOutcome): string {
	const status = outcome.timedOut ? "timed out" : `exit ${outcome.exitCode ?? "?"}`;
	return `${outcome.passed ? "[pass]" : "[FAIL]"} ${outcome.name}: ${outcome.argv.join(" ")} (${status}, ${(outcome.elapsedMs / 1000).toFixed(1)} s)`;
}

/**
 * The message a failed round sends back to the model. On a repeated failure of the same
 * checks it asks for a diagnosis before another edit: retrying the same fix is the common
 * failure after a first repair misses, and naming competing causes breaks that loop.
 */
export function formatCheckFeedback(
	outcomes: readonly CheckOutcome[],
	round: number,
	maxRounds: number,
	repeated: boolean,
): string {
	const lines = [`Harness checks failed after your changes (repair round ${round} of ${maxRounds}).`];
	for (const outcome of outcomes) {
		lines.push(describeOutcome(outcome));
		if (!outcome.passed) lines.push("<output>", boundOutput(outcome.output) || "(no output)", "</output>");
	}
	if (repeated) {
		lines.push(
			"The same checks failed again after your last fix. Before editing, state the most likely root cause and one alternative explanation, then check which one the output supports.",
		);
	}
	lines.push("Fix the cause, then finish. Do not weaken, skip or delete the checks or the tests they run.");
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
