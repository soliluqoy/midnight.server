import { spawnSync } from "node:child_process";

/**
 * Task commands for the harness eval, made portable. Tasks name `python3`, the only name
 * Linux and macOS reliably provide; on Windows `python3.exe` is a Microsoft Store placeholder
 * that exits with an error, and a real install provides `python` and `py`.
 */

let python;

/** A Python interpreter that actually runs, or undefined. */
function pythonCommand() {
	if (python === undefined) {
		const candidates = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
		python =
			candidates.find(
				(candidate) =>
					spawnSync(candidate, ["-c", "import sys"], { stdio: "ignore", windowsHide: true }).status === 0,
			) ?? null;
	}
	return python ?? undefined;
}

export function hasCommand(command) {
	if (command === "python3") return pythonCommand() !== undefined;
	return spawnSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" }).status === 0;
}

/**
 * Requirement-level results from a grader's output: one `REQ <id> PASS` or
 * `REQ <id> FAIL <reason>` line per requirement. Graders that print none return {}.
 */
export function parseRequirements(output) {
	const results = {};
	for (const line of output.split(/\r?\n/)) {
		const match = /^REQ (\S+) (PASS|FAIL)(?: (.*))?$/.exec(line);
		if (match) results[match[1]] = match[2] === "PASS" ? true : (match[3] ?? "").trim() || false;
	}
	return results;
}

/** `argv` with `python3` replaced by the interpreter that runs on this machine. */
export function portableArgv(argv) {
	if (argv[0] !== "python3") return argv;
	return [pythonCommand() ?? "python3", ...argv.slice(1)];
}
