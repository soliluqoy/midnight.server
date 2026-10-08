import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type GitSnapshot, markFromStatusCode, readGitSnapshot, runGit } from "./git-status.ts";

export { markFromStatusCode, runGit } from "./git-status.ts";

export interface WorkspaceEntry {
	name: string;
	path: string;
	directory: boolean;
}
export type WorkspaceFileMark = "M" | "A" | "D" | "R" | "?" | "U";
export interface WorkspaceGitStatus {
	marks: Map<string, WorkspaceFileMark>;
	ignored: Set<string>;
}
export interface WorkspaceSnapshot {
	children(dir: string): WorkspaceEntry[];
	error?(dir: string): string | undefined;
	mark(path: string): WorkspaceFileMark | undefined;
	containsMarks(dir: string): boolean;
	isIgnored(path: string): boolean;
}

export function parseGitStatus(output: string, prefix: string): WorkspaceGitStatus {
	const marks = new Map<string, WorkspaceFileMark>();
	const ignored = new Set<string>();
	const fields = output.split("\0");
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index];
		if (field.length < 4) continue;
		const code = field.slice(0, 2);
		const path = field.slice(3);
		if (/[RC]/.test(code)) index++;
		if (!path.startsWith(prefix)) continue;
		const relative = path.slice(prefix.length).replace(/\/$/, "");
		if (!relative) continue;
		if (code === "!!") ignored.add(relative);
		else {
			const mark = markFromStatusCode(code);
			if (mark) marks.set(relative, mark);
		}
	}
	return { marks, ignored };
}

/** Use symbolic-ref because it works even with no commits yet. rev-parse HEAD does not. */
export async function readGitBranch(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	const branch = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
	if (branch?.trim()) return branch.trim();
	if (signal?.aborted) return undefined;
	const head = await runGit(cwd, ["rev-parse", "--verify", "HEAD"], signal);
	return head?.trim() ? "detached" : undefined;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const DIRECTORY_CONCURRENCY = 8;

export interface WorkspaceIO {
	readDirectory(path: string): Promise<readonly { name: string; isDirectory(): boolean }[]>;
	prefix(root: string, signal?: AbortSignal): Promise<string | undefined>;
	git(root: string, prefix: string, signal?: AbortSignal): Promise<GitSnapshot | undefined>;
}
const defaultIO: WorkspaceIO = {
	readDirectory: (path) => readdir(path, { withFileTypes: true }),
	prefix: (root, signal) => runGit(root, ["rev-parse", "--show-prefix"], signal),
	git: readGitSnapshot,
};

/** Cache folder reads. Wait until hidden or closed folders are shown again before rereading them. */
export class Workspace implements WorkspaceSnapshot {
	private readonly cache = new Map<string, WorkspaceEntry[]>();
	private readonly fresh = new Map<string, number>();
	private readonly pending = new Map<string, Promise<void>>();
	private git: WorkspaceGitStatus = { marks: new Map(), ignored: new Set() };
	private readonly markedDirectories = new Set<string>();
	private generation = 0;
	private disposed = false;
	private batchGeneration: number | undefined;
	private changed = false;
	private notificationQueued = false;
	private prefix: string | undefined;
	private activeReads = 0;
	private readonly readQueue: (() => void)[] = [];
	private readonly root: string;
	private readonly onChange: () => void;
	private readonly io: WorkspaceIO;
	readonly errors = new Map<string, string>();

	constructor(root: string, onChange: () => void, io: Partial<WorkspaceIO> = {}) {
		this.root = root;
		this.onChange = onChange;
		this.io = { ...defaultIO, ...io };
	}

	children(dir: string): WorkspaceEntry[] {
		return this.cache.get(dir) ?? [];
	}

	async load(dir: string, force = false): Promise<void> {
		if (this.disposed || (!force && this.fresh.get(dir) === this.generation)) return;
		const existing = this.pending.get(dir);
		if (existing) return existing;
		const generation = this.generation;
		const task = this.readDirectory(dir, generation)
			.then((entries) => {
				if (this.disposed || generation !== this.generation) return;
				const next = entries
					.map((entry) => ({
						name: entry.name,
						path: dir ? `${dir}/${entry.name}` : entry.name,
						directory: entry.isDirectory(),
					}))
					.sort((a, b) => Number(b.directory) - Number(a.directory) || collator.compare(a.name, b.name));
				const previous = this.cache.get(dir);
				if (
					!previous ||
					previous.length !== next.length ||
					next.some(
						(entry, index) => entry.name !== previous[index].name || entry.directory !== previous[index].directory,
					)
				) {
					this.cache.set(dir, next);
					this.notify();
				}
				this.fresh.set(dir, generation);
				if (this.errors.delete(dir)) this.notify();
			})
			.catch((error: unknown) => {
				if (this.disposed || generation !== this.generation) return;
				this.cache.set(dir, []);
				this.fresh.set(dir, generation);
				this.errors.set(dir, error instanceof Error ? error.message : String(error));
				this.notify();
			})
			.finally(() => {
				if (generation === this.generation) this.pending.delete(dir);
			});
		this.pending.set(dir, task);
		return task;
	}

	private async readDirectory(dir: string, generation: number) {
		await new Promise<void>((resolve) => {
			const start = () => {
				this.activeReads++;
				resolve();
			};
			if (this.activeReads < DIRECTORY_CONCURRENCY) start();
			else this.readQueue.push(start);
		});
		try {
			if (this.disposed || generation !== this.generation) return [];
			return await this.io.readDirectory(join(this.root, dir));
		} finally {
			this.activeReads--;
			this.readQueue.shift()?.();
		}
	}

	private notify(): void {
		this.changed = true;
		if (this.batchGeneration !== undefined || this.notificationQueued || this.disposed) return;
		this.notificationQueued = true;
		queueMicrotask(() => {
			this.notificationQueued = false;
			if (this.disposed || this.batchGeneration !== undefined || !this.changed) return;
			this.changed = false;
			this.onChange();
		});
	}

	async refresh(signal?: AbortSignal, directories: readonly string[] = [""]): Promise<GitSnapshot | undefined> {
		if (this.disposed || signal?.aborted) return;
		const generation = ++this.generation;
		this.pending.clear();
		this.batchGeneration = generation;
		const abort = () => {
			if (generation !== this.generation) return;
			this.generation++;
			this.pending.clear();
			this.batchGeneration = undefined;
			if (this.changed) this.notify();
		};
		signal?.addEventListener("abort", abort, { once: true });
		const active = () => !this.disposed && !signal?.aborted && generation === this.generation;
		const git = async () => {
			// Reuse the prefix when we can. Retry failed reads in case a repo was created later.
			const prefix = this.prefix ?? (await this.io.prefix(this.root, signal));
			if (!active()) return;
			if (prefix !== undefined) this.prefix = prefix.replace(/\r?\n$/, "");
			const snapshot = this.prefix === undefined ? undefined : await this.io.git(this.root, this.prefix, signal);
			if (!active()) return;
			if (!snapshot) this.prefix = undefined;
			const next = snapshot ?? { marks: new Map(), ignored: new Set<string>() };
			if (!sameGit(this.git, next)) {
				this.git = next;
				this.markedDirectories.clear();
				for (const path of this.git.marks.keys()) {
					for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1))
						this.markedDirectories.add(path.slice(0, slash));
				}
				this.notify();
			}
			return snapshot;
		};
		const queue = [...new Set(directories)].values();
		const worker = async () => {
			for (const dir of queue) {
				if (!active()) return;
				await this.load(dir, true);
			}
		};
		const files = Promise.all(
			Array.from({ length: Math.min(DIRECTORY_CONCURRENCY, directories.length) }, worker),
		).finally(() => {
			if (this.batchGeneration !== generation) return;
			this.batchGeneration = undefined;
			if (this.changed) this.notify();
		});
		try {
			// Show folder results without waiting for Git to finish.
			const [snapshot] = await Promise.all([git(), files]);
			return active() ? snapshot : undefined;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	mark(path: string): WorkspaceFileMark | undefined {
		return this.git.marks.get(path);
	}
	containsMarks(dir: string): boolean {
		return dir === "" ? this.git.marks.size > 0 : this.markedDirectories.has(dir);
	}
	isIgnored(path: string): boolean {
		if (path === ".git" || path.startsWith(".git/")) return true;
		if (this.git.ignored.has(path)) return true;
		for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1))
			if (this.git.ignored.has(path.slice(0, slash))) return true;
		return false;
	}
	dispose(): void {
		this.disposed = true;
		this.generation++;
		this.pending.clear();
	}
}

function sameGit(a: WorkspaceGitStatus, b: WorkspaceGitStatus): boolean {
	return (
		a.marks.size === b.marks.size &&
		a.ignored.size === b.ignored.size &&
		[...a.marks].every(([path, mark]) => b.marks.get(path) === mark) &&
		[...a.ignored].every((path) => b.ignored.has(path))
	);
}
