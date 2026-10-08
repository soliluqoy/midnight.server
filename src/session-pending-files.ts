import path from "node:path";
import { type GitPathStatus, type GitSnapshot, readGitSnapshot } from "./git-status.ts";
import { patchToDisplayDiff, type SessionDiffSection } from "./session-diff.ts";
import type { SessionFileChange } from "./session-file-changes.ts";
import {
	candidateIdentity,
	currentText,
	fileStamp,
	MAX_PENDING_BYTES,
	MAX_PENDING_LINES,
	owningRepository,
	pendingGit,
	repositoryStamp,
} from "./session-pending-io.ts";

export async function pendingStatus(root: string, signal: AbortSignal): Promise<GitSnapshot> {
	const snapshot = await readGitSnapshot(root, "", signal);
	if (!snapshot) throw new Error("Git status unavailable (failed, truncated, cancelled, or repository changed).");
	return snapshot;
}

export interface PendingFile {
	path: string;
	absolute: string;
	history: SessionFileChange;
	state: "pending" | "clean" | "checking" | "unavailable";
	generation: number;
	reason?: string;
	added?: number;
	removed?: number;
	root?: string;
	status?: GitPathStatus;
	stamp?: string;
	repositoryStamp?: string;
}
export interface PendingSnapshot {
	generation: number;
	rows: PendingFile[];
	changedPaths: ReadonlySet<string>;
}
export interface PendingIO {
	identity: typeof candidateIdentity;
	owner: typeof owningRepository;
	status: typeof pendingStatus;
	git: typeof pendingGit;
	stamp: typeof fileStamp;
	repositoryStamp: typeof repositoryStamp;
	text: typeof currentText;
}
const defaultIO: PendingIO = {
	identity: candidateIdentity,
	owner: owningRepository,
	status: pendingStatus,
	git: pendingGit,
	stamp: fileStamp,
	repositoryStamp,
	text: currentText,
};
const diffOptions = [
	"--no-ext-diff",
	"--no-textconv",
	"--no-color",
	"--find-renames",
	"--diff-algorithm=myers",
	"--no-indent-heuristic",
];

export function absoluteCandidate(cwd: string, file: string, paths = path): string {
	const absolute = paths.resolve(cwd, file);
	return paths.sep === "\\" ? absolute.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : absolute;
}
function relativeFile(root: string, absolute: string): string {
	return path.relative(root, absolute).split(path.sep).join("/");
}
function reference(cwd: string, absolute: string): string {
	const rel = relativeFile(cwd, absolute);
	return rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel) ? rel : absolute;
}
function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** -z keeps tabs and newlines in file names, plus both paths for renames. */
export function parseNumstat(output: string): Map<string, { added: number; removed: number } | undefined> {
	const result = new Map<string, { added: number; removed: number } | undefined>();
	if (output && !output.endsWith("\0")) throw new Error("Incomplete Git numstat output.");
	const fields = output.split("\0");
	for (let i = 0; i < fields.length - 1; i++) {
		const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i]);
		if (!match) throw new Error("Unrecognized Git numstat output.");
		let name = match[3];
		if (!name) {
			i++;
			name = fields[++i];
		}
		if (name === undefined) throw new Error("Incomplete Git numstat output.");
		result.set(
			name,
			match[1] === "-" || match[2] === "-" ? undefined : { added: Number(match[1]), removed: Number(match[2]) },
		);
	}
	return result;
}

function unsupported(status: GitPathStatus): string | undefined {
	if (status.kind === "u") return "Conflict — unmerged index; counts unavailable.";
	if (status.metadata[2]?.startsWith("S")) return "Submodule changes; counts unavailable.";
	const modes = status.metadata.slice(3, 6).filter((mode) => mode !== "000000");
	if (status.kind !== "?" && (modes.some((mode) => !mode.startsWith("100")) || new Set(modes).size > 1))
		return "Mode, symlink or type change; counts unavailable.";
	return undefined;
}
function pathsFor(row: PendingFile): string[] {
	return [...new Set([row.status?.oldPath, row.status?.path].filter((p): p is string => p !== undefined))];
}

/** Check current changes with async reads. The caller groups refreshes and shares the project Git scan. */
export class SessionPendingFiles {
	private generation = 0;
	private controller: AbortController | undefined;
	private disposed = false;
	private readonly cwd: string;
	private readonly io: PendingIO;
	snapshot: PendingSnapshot = { generation: 0, rows: [], changedPaths: new Set() };

	constructor(cwd: string, io: Partial<PendingIO> = {}) {
		this.cwd = cwd;
		this.io = { ...defaultIO, ...io };
	}

	cancel(): void {
		this.generation++;
		this.controller?.abort();
	}
	dispose(): void {
		this.disposed = true;
		this.cancel();
	}

	async reconcile(
		candidates: readonly SessionFileChange[],
		project: GitSnapshot | undefined,
		signal?: AbortSignal,
	): Promise<PendingSnapshot | undefined> {
		if (this.disposed || signal?.aborted) return;
		this.cancel();
		const generation = this.generation;
		const controller = new AbortController();
		this.controller = controller;
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		const active = () => !this.disposed && !controller.signal.aborted && generation === this.generation;
		const io = this.io;
		// Recheck each file's repo on refresh. A check may have failed, or a new repo may now exist.
		const owners = new Map<string, Promise<string | undefined>>();
		const owner = (file: string) => {
			const parent = path.dirname(file);
			let task = owners.get(parent);
			if (!task) {
				task = io.owner(file, controller.signal);
				owners.set(parent, task);
			}
			return task;
		};
		try {
			if (!candidates.length) {
				this.snapshot = { generation, rows: [], changedPaths: new Set() };
				return this.snapshot;
			}
			// Keep the real disk path separate from the path shown or added to the prompt.
			let displayRoot = this.cwd;
			try {
				displayRoot = path.dirname(await io.identity(path.join(this.cwd, "__midnight_owner__")));
			} catch {
				/* Each file check below reports its own errors. */
			}
			let projectRoot = project?.root;
			if (!projectRoot) {
				try {
					projectRoot = await owner(path.join(this.cwd, "__midnight_owner__"));
				} catch {
					/* Leave the project root unknown if this check fails. */
				}
			}
			const repositories = new Map<string, Promise<{ status: GitSnapshot; stamp: string }>>();
			const repository = (root: string) => {
				let task = repositories.get(root);
				if (!task) {
					task = (async () => {
						const status = root === projectRoot ? project : await io.status(root, controller.signal);
						if (!status) throw new Error("Working-project Git status unavailable.");
						// Git status already checked the repo stamp. Check it again after reading diffs.
						const stamp = status.repositoryStamp ?? (await io.repositoryStamp(root, controller.signal));
						return { status, stamp };
					})();
					repositories.set(root, task);
				}
				return task;
			};
			const rows: PendingFile[] = candidates.map((history) => ({
				history,
				path: history.path,
				absolute: absoluteCandidate(this.cwd, history.path),
				state: "checking",
				reason: "Checking current state",
				generation,
			}));
			const queue = rows.values();
			const worker = async () => {
				for (const row of queue) {
					if (!active()) return;
					try {
						row.absolute = await io.identity(row.absolute);
						row.root = await owner(row.absolute);
						if (!row.root) {
							row.state = (await io.stamp(row.absolute)) === "absent" ? "clean" : "unavailable";
							row.reason = "Non-Git path — history only.";
							continue;
						}
						const repo = await repository(row.root);
						const rel = relativeFile(row.root, row.absolute);
						const status = repo.status.paths.find(
							(entry) => entry.path === rel || (entry.oldPath === rel && entry.code.includes("R")),
						);
						const ignored = repo.status.paths.some(
							(entry) => entry.kind === "!" && (entry.path === rel || rel.startsWith(`${entry.path}/`)),
						);
						if (ignored) {
							row.state = (await io.stamp(row.absolute)) === "absent" ? "clean" : "unavailable";
							row.reason = "Ignored path — history only.";
							continue;
						}
						if (!status) {
							// Git status can succeed even when we cannot read this file. Check before calling it clean.
							await io.stamp(row.absolute);
							if (rel === ".git" || rel.startsWith(".git/")) throw new Error("Git metadata — history only.");
							row.state = "clean";
							row.reason = "No pending changes remain.";
							continue;
						}
						row.status = status;
						row.absolute = absoluteCandidate(row.root, status.path);
						row.path = reference(displayRoot, row.absolute);
						row.stamp = await io.stamp(row.absolute);
						row.repositoryStamp = repo.stamp;
						row.state = "pending";
						row.reason = unsupported(status);
						if (!row.reason && status.kind === "?") await this.countUntracked(row);
						if (row.stamp !== (await io.stamp(row.absolute)))
							throw new Error("File changed while checking; refresh again.");
					} catch (error) {
						row.state = "unavailable";
						row.reason = reason(error);
						row.added = row.removed = undefined;
					}
				}
			};
			await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
			// Group line-count reads by repo and staged/unstaged changes. Keep commands short enough for Windows.
			for (const root of repositories.keys()) {
				const tracked = rows.filter(
					(row) => row.root === root && row.state === "pending" && !row.reason && row.status?.kind !== "?",
				);
				let batch: PendingFile[] = [];
				let size = 0;
				for (const row of tracked) {
					const length = pathsFor(row).join("").length + 16;
					if (batch.length && (size + length > 6000 || batch.length >= 64)) {
						await this.countTracked(batch, controller.signal);
						batch = [];
						size = 0;
					}
					batch.push(row);
					size += length;
				}
				if (batch.length) await this.countTracked(batch, controller.signal);
			}
			for (const row of rows.filter((row) => row.state === "pending")) {
				try {
					if (row.stamp !== (await io.stamp(row.absolute)))
						throw new Error("File changed while checking; refresh again.");
				} catch (error) {
					row.state = "unavailable";
					row.reason = reason(error);
					row.added = row.removed = undefined;
				}
			}
			for (const [root, task] of repositories) {
				if (!active()) return;
				try {
					const repo = await task;
					if (repo.stamp !== (await io.repositoryStamp(root, controller.signal)))
						throw new Error("Repository changed while checking; refresh again.");
				} catch (error) {
					for (const row of rows.filter((row) => row.root === root)) {
						row.state = "unavailable";
						row.reason = reason(error);
						row.added = row.removed = undefined;
					}
				}
			}
			if (!active()) return;
			const seen = new Set<string>();
			const unique = rows.filter((row) => {
				if (seen.has(row.absolute)) return false;
				seen.add(row.absolute);
				return true;
			});
			this.snapshot = {
				generation,
				rows: unique,
				changedPaths: new Set(unique.filter((row) => row.state === "pending").map((row) => row.path)),
			};
			return this.snapshot;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	private async countUntracked(row: PendingFile): Promise<void> {
		if (row.status?.kind === "?") {
			try {
				const text = await this.io.text(row.absolute);
				row.added = text ? text.replace(/\n$/, "").split("\n").length : 0;
				row.removed = 0;
			} catch (error) {
				row.reason = reason(error);
			}
			return;
		}
	}

	private async countTracked(rows: PendingFile[], signal: AbortSignal): Promise<void> {
		for (const row of rows) {
			row.added = 0;
			row.removed = 0;
		}
		try {
			for (const staged of [true, false]) {
				const active = rows.filter((row) => row.status?.code[staged ? 0 : 1] !== ".");
				if (!active.length) continue;
				const output = await this.io.git(
					rows[0].root as string,
					[
						"diff",
						...diffOptions,
						...(staged ? ["--cached"] : []),
						"--numstat",
						"-z",
						"--",
						...new Set(active.flatMap(pathsFor)),
					],
					signal,
				);
				const stats = parseNumstat(output);
				for (const row of active) {
					const stat = stats.get(row.status?.path ?? "");
					if (!stat) {
						if (!stats.has(row.status?.path ?? "")) row.state = "unavailable";
						row.reason = stats.has(row.status?.path ?? "")
							? "Binary content; counts unavailable."
							: "Metadata-only or concurrently changed; counts unavailable.";
						continue;
					}
					row.added = (row.added ?? 0) + stat.added;
					row.removed = (row.removed ?? 0) + stat.removed;
				}
			}
		} catch (error) {
			for (const row of rows) {
				row.state = "unavailable";
				row.reason = reason(error);
			}
		}
		for (const row of rows) if (row.reason) row.added = row.removed = undefined;
	}

	/** Refresh first. Show current changes, never old saved content. */
	async preview(row: PendingFile): Promise<SessionDiffSection[]> {
		const signal = this.controller?.signal;
		if (!signal || row.generation !== this.snapshot.generation || signal.aborted)
			return [{ title: "Current changes", message: "Snapshot expired; refresh again." }];
		try {
			if (row.state !== "pending") return [{ title: "Current changes", message: row.reason ?? "Status unavailable." }];
			const sections: SessionDiffSection[] = [];
			if (row.status?.oldPath)
				sections.push({ title: "Rename / copy", message: `${row.status.oldPath} → ${row.status.path}` });
			if (row.reason) return [...sections, { title: "Current changes", message: row.reason }];
			let bytes = 0;
			let lines = 0;
			if (row.status?.kind === "?") {
				const text = await this.io.text(row.absolute);
				sections.push({
					title: "Untracked — empty → working tree",
					diff: text
						? text
								.replace(/\n$/, "")
								.split("\n")
								.map((line, i) => `+${i + 1} ${line}`)
								.join("\n")
						: undefined,
					message: text ? undefined : "Empty untracked file.",
				});
			} else {
				for (const staged of [true, false]) {
					if (row.status?.code[staged ? 0 : 1] === ".") continue;
					const patch = await this.io.git(
						row.root as string,
						["diff", ...diffOptions, ...(staged ? ["--cached"] : []), "--patch", "--unified=3", "--", ...pathsFor(row)],
						signal,
					);
					bytes += Buffer.byteLength(patch);
					lines += patch.split("\n").length;
					if (bytes > MAX_PENDING_BYTES || lines > MAX_PENDING_LINES)
						throw new Error("Preview exceeds 1 MiB / 20,000 source-line limit; counts describe the full delta.");
					sections.push({
						title: staged ? "Staged — HEAD (or empty tree) → index" : "Unstaged — index → working tree",
						diff: patchToDisplayDiff(patch),
						message: /^(rename|copy) (from|to) /m.test(patch) ? "Includes rename/copy metadata." : undefined,
					});
				}
			}
			if (
				row.stamp !== (await this.io.stamp(row.absolute)) ||
				row.repositoryStamp !== (await this.io.repositoryStamp(row.root as string, signal))
			)
				throw new Error("Changed during preview; refresh again. No atomic snapshot claimed.");
			if (signal.aborted || row.generation !== this.snapshot.generation)
				throw new Error("Snapshot expired; refresh again.");
			return sections;
		} catch (error) {
			return [{ title: "Current changes unavailable", message: reason(error) }];
		}
	}
}
