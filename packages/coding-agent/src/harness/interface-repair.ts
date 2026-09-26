import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { workspaceRelative } from "./checks.ts";

/**
 * Deterministic repairs of tool arguments that models commonly get wrong in ways that have
 * exactly one sensible reading. Each repair is reported back to the model so it can adjust.
 *
 * Problem, observed with the local 2B model: asked to fix `math.js`, it called
 * `read {"path":"/workspace/math.js"}` (a sandbox path from training data), got ENOENT on
 * `C:\workspace\math.js`, then ran `find / -name "math.js" 2>/dev/null` in PowerShell, where
 * `/dev/null` is not a path either. Three turns and ~40 s of CPU went to the environment
 * mismatch, not the task.
 */

/** Tools whose `path` argument must name an existing file or directory. */
const EXISTING_PATH_TOOLS = new Set(["read", "edit", "ls", "grep", "find"]);

/**
 * Map an absolute path whose top-level directory does not exist on this machine into the
 * workspace, by dropping leading segments until the rest names something inside `cwd`.
 * Real absolute paths (whose root directory exists) are never rewritten.
 *
 * Example: cwd `C:\proj`, `/workspace/src/math.js` -> `src/math.js` when `C:\proj\src\math.js`
 * exists (or, for `write`, when `C:\proj\src` exists).
 */
export function remapForeignPath(cwd: string, path: string, mustExist: boolean): string | undefined {
	if (!isAbsolute(path)) return undefined;
	const absolute = resolve(path);
	if (existsSync(absolute) || workspaceRelative(cwd, absolute)) return undefined;
	const { root } = parse(absolute);
	const segments = absolute.slice(root.length).split(sep).filter(Boolean);
	if (segments.length < 2 || existsSync(join(root, segments[0]))) return undefined;
	for (let start = 1; start < segments.length; start++) {
		const candidate = join(cwd, ...segments.slice(start));
		if (mustExist ? existsSync(candidate) : existsSync(dirname(candidate))) {
			return segments.slice(start).join("/");
		}
	}
	return undefined;
}

export function toolNeedsExistingPath(toolName: string): boolean {
	return EXISTING_PATH_TOOLS.has(toolName);
}

const POSIX_NULL_REDIRECTS: Array<[RegExp, string]> = [
	[/&>\s*\/dev\/null/g, "*>$$null"],
	[/(\d)>\s*\/dev\/null/g, "$1>$$null"],
	[/>\s*\/dev\/null/g, ">$$null"],
];

/** Rewrite POSIX null-device redirects for PowerShell. Returns undefined when nothing changed. */
export function repairPowerShellCommand(command: string): string | undefined {
	let repaired = command;
	for (const [pattern, replacement] of POSIX_NULL_REDIRECTS) repaired = repaired.replace(pattern, replacement);
	return repaired === command ? undefined : repaired;
}
