import { type ExecFileException, execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** One file or directory, with its path relative to the workspace root using `/` separators. */
export interface WorkspaceEntry {
	name: string;
	path: string;
	directory: boolean;
}

/** Short git status marker for a path: modified, added, deleted, renamed, untracked, or conflicted. */
export type WorkspaceFileMark = "M" | "A" | "D" | "R" | "?" | "U";

export interface WorkspaceSnapshot {
	/** Direct children of `dir` ("" for the root): directories first, then files, each sorted by name. */
	children(dir: string): WorkspaceEntry[];
	mark(path: string): WorkspaceFileMark | undefined;
	/** True when any path under `dir` has a git mark. */
	containsMarks(dir: string): boolean;
	/** True for gitignored paths, anything inside an ignored folder, and `.git` itself. */
	isIgnored(path: string): boolean;
}

/** Git status for a workspace: per-path marks and the ignored paths git reports. */
export interface WorkspaceGitStatus {
	marks: Map<string, WorkspaceFileMark>;
	/** Ignored files and folders; an ignored folder is listed once, not file by file. */
	ignored: Set<string>;
}

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

function compareEntries(a: WorkspaceEntry, b: WorkspaceEntry): number {
	if (a.directory !== b.directory) return a.directory ? -1 : 1;
	return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
}

/** Map a porcelain v1 `XY` code to one marker; the working-tree side wins over the index side. */
export function markFromStatusCode(code: string): WorkspaceFileMark | undefined {
	if (code === "??") return "?";
	if (code.includes("U") || code === "AA" || code === "DD") return "U";
	for (const letter of [code[1], code[0]]) {
		if (letter === "M" || letter === "T") return "M";
		if (letter === "A") return "A";
		if (letter === "D") return "D";
		if (letter === "R" || letter === "C") return "R";
	}
	return undefined;
}

/**
 * Parse `git status --porcelain=v1 -z --ignored=matching` into marks and ignored paths keyed by
 * path relative to `prefix` (the workspace's path inside the repository, from
 * `git rev-parse --show-prefix`). Paths outside the prefix are dropped.
 */
export function parseGitStatus(output: string, prefix: string): WorkspaceGitStatus {
	const marks = new Map<string, WorkspaceFileMark>();
	const ignored = new Set<string>();
	const fields = output.split("\0");
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index]!;
		if (field.length < 4) continue;
		const code = field.slice(0, 2);
		const path = field.slice(3);
		// Renames and copies carry the original path in the next field.
		if (code[0] === "R" || code[0] === "C") index++;
		if (!path.startsWith(prefix)) continue;
		const relativePath = path.slice(prefix.length).replace(/\/$/, "");
		if (!relativePath) continue;
		if (code === "!!") {
			ignored.add(relativePath);
			continue;
		}
		const mark = markFromStatusCode(code);
		if (mark) marks.set(relativePath, mark);
	}
	return { marks, ignored };
}

/**
 * Snapshot that lists the file system lazily, one directory at a time when it is first expanded.
 * Everything is listed, including gitignored files, `node_modules` and `.git`; `git` only adds status
 * marks and which paths to show as ignored.
 */
export function createFileSystemSnapshot(
	root: string,
	git: WorkspaceGitStatus = { marks: new Map(), ignored: new Set() },
): WorkspaceSnapshot {
	const { marks, ignored } = git;
	const markedDirectories = new Set<string>();
	for (const path of marks.keys()) {
		const parts = path.split("/");
		for (let length = 1; length < parts.length; length++) markedDirectories.add(parts.slice(0, length).join("/"));
	}
	const cache = new Map<string, WorkspaceEntry[]>();
	return {
		children(dir) {
			let entries = cache.get(dir);
			if (!entries) {
				try {
					entries = readdirSync(join(root, dir), { withFileTypes: true })
						.map((dirent) => ({
							name: dirent.name,
							path: dir ? `${dir}/${dirent.name}` : dirent.name,
							directory: dirent.isDirectory(),
						}))
						.sort(compareEntries);
				} catch {
					entries = [];
				}
				cache.set(dir, entries);
			}
			return entries;
		},
		mark: (path) => marks.get(path),
		containsMarks: (dir) => markedDirectories.has(dir),
		isIgnored(path) {
			const parts = path.split("/");
			if (parts[0] === ".git") return true;
			for (let length = 1; length <= parts.length; length++) {
				if (ignored.has(parts.slice(0, length).join("/"))) return true;
			}
			return false;
		},
	};
}

function runGit(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			["--no-optional-locks", ...args],
			{ cwd, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES, windowsHide: true },
			(error: ExecFileException | null, stdout: string) => resolvePromise(error ? undefined : stdout),
		);
	});
}

/** Read the workspace under `cwd` from the file system, with git status marks when it is inside a repository. */
export async function readWorkspaceSnapshot(cwd: string): Promise<WorkspaceSnapshot> {
	const [prefix, status] = await Promise.all([
		runGit(cwd, ["rev-parse", "--show-prefix"]),
		// `matching` reports an ignored folder once instead of every file inside it.
		runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]),
	]);
	if (prefix === undefined || status === undefined) return createFileSystemSnapshot(cwd);
	return createFileSystemSnapshot(cwd, parseGitStatus(status, prefix.trim()));
}
