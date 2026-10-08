import { type ExecFileException, execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { repositoryStamp } from "./session-pending-io.ts";
import type { WorkspaceFileMark, WorkspaceGitStatus } from "./workspace-files.ts";

export interface GitPathStatus {
	path: string;
	oldPath?: string;
	code: string;
	kind: string;
	/** Keep Git's file modes and submodule flags to spot changes we cannot show as text. */
	metadata: string[];
}

export interface GitSnapshot extends WorkspaceGitStatus {
	root?: string;
	repositoryStamp?: string;
	paths: GitPathStatus[];
	branch: string;
	summary?: GitStatusSummary;
}

export function markFromStatusCode(code: string): WorkspaceFileMark | undefined {
	if (code === "??") return "?";
	if (code.includes("U") || code === "AA" || code === "DD") return "U";
	for (const letter of [code[1], code[0]]) {
		if (letter === "M" || letter === "T") return "M";
		if (letter === "A" || letter === "D") return letter;
		if (letter === "R" || letter === "C") return "R";
	}
	return undefined;
}

export function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string | undefined> {
	if (signal?.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		execFile(
			"git",
			["--no-optional-locks", ...args],
			{
				cwd,
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
				windowsHide: true,
				signal,
				timeout: 5000,
			},
			(error, stdout) => resolve(error ? undefined : stdout),
		);
	});
}

/** Split on zero bytes to keep spaces and newlines in paths, including old rename paths. */
export function parseGitSnapshot(output: string, prefix = ""): GitSnapshot {
	const summary: GitStatusSummary = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, changedFiles: 0 };
	const snapshot: GitSnapshot = {
		branch: "",
		paths: [],
		summary,
		marks: new Map(),
		ignored: new Set(),
	};
	const fields = output.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const record = fields[i];
		if (record.startsWith("# branch.head ")) {
			const name = record.slice(14);
			snapshot.branch = name === "(detached)" ? "detached" : name;
			continue;
		}
		if (record.startsWith("# branch.ab ")) {
			const match = /^# branch\.ab \+(\d+) -(\d+)/.exec(record);
			if (match) {
				summary.ahead = Number(match[1]);
				summary.behind = Number(match[2]);
			}
			continue;
		}
		const kind = record[0];
		if (!record || !["1", "2", "u", "?", "!"].includes(kind)) continue;
		let pathStart = 0;
		const columns = kind === "1" ? 8 : kind === "2" ? 9 : kind === "u" ? 10 : 1;
		for (let column = 0; column < columns; column++) {
			const space = record.indexOf(" ", pathStart);
			if (space < 0) {
				pathStart = -1;
				break;
			}
			pathStart = space + 1;
		}
		const oldPath = kind === "2" ? fields[++i] : undefined;
		if (pathStart < 0) continue;
		const path = record.slice(pathStart).replace(/\/$/, "");
		const code = kind === "?" ? "??" : kind === "!" ? "!!" : record.slice(2, 4);
		snapshot.paths.push({ path, oldPath, code, kind, metadata: record.slice(0, pathStart - 1).split(" ") });
		if (kind === "?") summary.untracked++;
		else if (kind === "u") summary.conflicted++;
		else if (kind !== "!") {
			if (code[0] !== ".") summary.staged++;
			if (code[1] !== ".") summary.unstaged++;
		}
		if (kind !== "!") summary.changedFiles++;
		if (!path.startsWith(prefix)) continue;
		const relative = path.slice(prefix.length);
		if (!relative) continue;
		if (kind === "!") snapshot.ignored.add(relative);
		else {
			const mark = kind === "?" ? "?" : kind === "u" ? "U" : markFromStatusCode(code);
			if (mark) snapshot.marks.set(relative, mark);
		}
	}
	return snapshot;
}

/** Get the branch, counts, file marks, and ignored paths with one Git status scan. */
export async function readGitSnapshot(
	cwd: string,
	prefix: string,
	signal?: AbortSignal,
): Promise<GitSnapshot | undefined> {
	const activeSignal = signal ?? new AbortController().signal;
	try {
		// Check the repo root again. Someone may have run git init in a folder inside it.
		const top = await runGit(cwd, ["rev-parse", "--show-toplevel"], signal);
		if (top === undefined) return undefined;
		const root = await realpath(top.replace(/\r?\n$/, ""));
		const currentPrefix = relative(root, await realpath(cwd))
			.split(sep)
			.join("/");
		prefix = currentPrefix ? `${currentPrefix}/` : "";
		const stamp = await repositoryStamp(root, activeSignal);
		const output = await runGit(
			cwd,
			["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignored=matching"],
			signal,
		);
		if (output === undefined || stamp !== (await repositoryStamp(root, activeSignal))) return undefined;
		const snapshot = parseGitSnapshot(output, prefix);
		snapshot.root = root;
		snapshot.repositoryStamp = stamp;
		return snapshot;
	} catch {
		return undefined;
	}
}

export interface GitStatusSummary {
	/** Commits ahead of or behind the upstream branch. Missing if none is set. */
	ahead?: number;
	behind?: number;
	staged: number;
	/** Only tracked files count here. */
	unstaged: number;
	untracked: number;
	conflicted: number;
	/** Count each file once, even if it has both staged and unstaged changes. */
	changedFiles: number;
}

/** Skip status lines we do not know. */
export function parseGitStatusPorcelainV2(output: string): GitStatusSummary {
	const summary: GitStatusSummary = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, changedFiles: 0 };
	for (const line of output.split(/\r?\n/)) {
		if (line.startsWith("# branch.ab ")) {
			const match = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
			if (match) {
				summary.ahead = Number(match[1]);
				summary.behind = Number(match[2]);
			}
		} else if (line.startsWith("1 ") || line.startsWith("2 ")) {
			const xy = line.slice(2, 4);
			if (xy[0] !== ".") summary.staged++;
			if (xy[1] !== ".") summary.unstaged++;
			summary.changedFiles++;
		} else if (line.startsWith("u ")) {
			summary.conflicted++;
			summary.changedFiles++;
		} else if (line.startsWith("? ")) {
			summary.untracked++;
			summary.changedFiles++;
		}
	}
	return summary;
}

const MAX_STATUS_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Return undefined if Git is missing or fails. */
export function readGitStatus(repoDir: string, signal?: AbortSignal): Promise<GitStatusSummary | undefined> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
			{
				cwd: repoDir,
				encoding: "utf8",
				maxBuffer: MAX_STATUS_OUTPUT_BYTES,
				windowsHide: true,
				signal,
				timeout: 5000,
			},
			(error: ExecFileException | null, stdout: string) => {
				resolvePromise(error ? undefined : parseGitStatusPorcelainV2(stdout));
			},
		);
	});
}

/**
 * Cache Git status for one folder. Refresh only when asked.
 * If more requests arrive during a refresh, do one extra refresh after it.
 * Tell listeners only when the summary changes.
 */
export class GitStatusTracker {
	private cwd: string;
	private status: GitStatusSummary | undefined;
	private inFlight = false;
	private pending = false;
	private disposed = false;
	private readonly listeners = new Set<() => void>();
	private readonly read: (cwd: string, signal?: AbortSignal) => Promise<GitStatusSummary | undefined>;
	private controller: AbortController | undefined;

	constructor(
		cwd: string,
		read: (cwd: string, signal?: AbortSignal) => Promise<GitStatusSummary | undefined> = readGitStatus,
	) {
		this.cwd = cwd;
		this.read = read;
	}

	getStatus(): GitStatusSummary | undefined {
		return this.status;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setCwd(cwd: string): void {
		if (cwd === this.cwd) return;
		this.cwd = cwd;
		this.controller?.abort();
		this.pending = false;
		this.update(undefined);
	}

	async refresh(): Promise<void> {
		if (this.disposed) return;
		if (this.inFlight) {
			this.pending = true;
			return;
		}
		this.inFlight = true;
		try {
			const cwd = this.cwd;
			const controller = new AbortController();
			this.controller = controller;
			const next = await this.read(cwd, controller.signal);
			if (!controller.signal.aborted && !this.disposed && cwd === this.cwd) this.update(next);
		} finally {
			this.inFlight = false;
			if (this.pending && !this.disposed) {
				this.pending = false;
				void this.refresh();
			}
		}
	}

	cancelRefresh(): void {
		this.pending = false;
		this.controller?.abort();
	}

	dispose(): void {
		this.disposed = true;
		this.cancelRefresh();
		this.listeners.clear();
	}

	private update(next: GitStatusSummary | undefined): void {
		if (JSON.stringify(next) === JSON.stringify(this.status)) return;
		this.status = next;
		for (const listener of this.listeners) listener();
	}
}
