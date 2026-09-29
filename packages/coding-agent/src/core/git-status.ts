import { type ExecFileException, execFile } from "child_process";

/** Working-tree summary from `git status --porcelain=v2 --branch`. */
export interface GitStatusSummary {
	/** Commits ahead of / behind the upstream; undefined without an upstream. */
	ahead?: number;
	behind?: number;
	/** Files with staged changes. */
	staged: number;
	/** Tracked files with unstaged changes. */
	unstaged: number;
	untracked: number;
	conflicted: number;
	/** Distinct changed paths; a file with both staged and unstaged changes counts once. */
	changedFiles: number;
}

/** Parse `git status --porcelain=v2 --branch` output. Unknown lines are ignored. */
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

/** Run `git status` in `repoDir`. Resolves undefined when git is unavailable or fails. */
export function readGitStatus(repoDir: string): Promise<GitStatusSummary | undefined> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
			{ cwd: repoDir, encoding: "utf8", maxBuffer: MAX_STATUS_OUTPUT_BYTES, windowsHide: true },
			(error: ExecFileException | null, stdout: string) => {
				resolvePromise(error ? undefined : parseGitStatusPorcelainV2(stdout));
			},
		);
	});
}

/**
 * Cached working-tree status for one directory. Refreshes are explicit (after agent runs,
 * on branch changes) and coalesce: a refresh requested while one is running schedules
 * exactly one follow-up. Listeners fire only when the summary changes.
 */
export class GitStatusTracker {
	private cwd: string;
	private status: GitStatusSummary | undefined;
	private inFlight = false;
	private pending = false;
	private disposed = false;
	private readonly listeners = new Set<() => void>();
	private readonly read: (cwd: string) => Promise<GitStatusSummary | undefined>;

	constructor(cwd: string, read: (cwd: string) => Promise<GitStatusSummary | undefined> = readGitStatus) {
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
		this.update(undefined);
		void this.refresh();
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
			const next = await this.read(cwd);
			if (!this.disposed && cwd === this.cwd) this.update(next);
		} finally {
			this.inFlight = false;
			if (this.pending && !this.disposed) {
				this.pending = false;
				void this.refresh();
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		this.listeners.clear();
	}

	private update(next: GitStatusSummary | undefined): void {
		if (JSON.stringify(next) === JSON.stringify(this.status)) return;
		this.status = next;
		for (const listener of this.listeners) listener();
	}
}
