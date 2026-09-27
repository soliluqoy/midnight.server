import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isGeneratedPath } from "./workspace-index.ts";

/**
 * Snapshots of the working tree in private git refs, and restoring one.
 *
 * Problem: after a fix fails its checks twice, a weak model tends to pile a third fix on the
 * first two instead of reconsidering. The files drift further from any working state.
 *
 * Solution: each time the checks pass, the harness snapshots the working tree. When the same
 * checks then fail twice in a row, it restores the files the agent changed to the last passing
 * snapshot and shows the model the change it reverted, so the next attempt starts from working
 * code with the failed idea in view. Files the agent did not change are left alone.
 *
 * A snapshot is a commit under `refs/midnight/checkpoints/`, built with a temporary index
 * file. The user's index, branches, HEAD and stash are never touched. Refs are deleted when
 * the session ends.
 */

export interface Checkpoint {
	ref: string;
	commit: string;
	tree: string;
	createdAt: number;
	label: string;
}

const REF_PREFIX = "refs/midnight/checkpoints";
const MAX_DIFF_BYTES = 12_000;

function git(cwd: string, args: string[], env?: Record<string, string>, input?: string) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: env ? { ...process.env, ...env } : process.env,
		input,
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true,
		timeout: 60_000,
	});
	return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function isGitWorkTree(cwd: string): boolean {
	const result = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	return result.ok && result.stdout.trim() === "true";
}

function repoRoot(cwd: string): string | undefined {
	const result = git(cwd, ["rev-parse", "--show-toplevel"]);
	return result.ok ? result.stdout.trim() : undefined;
}

export class CheckpointStore {
	private readonly checkpoints: Checkpoint[] = [];
	private readonly cwd: string;
	private readonly sessionTag: string;
	private counter = 0;

	constructor(cwd: string, sessionTag: string) {
		this.cwd = cwd;
		this.sessionTag = sessionTag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "session";
	}

	get latest(): Checkpoint | undefined {
		return this.checkpoints[this.checkpoints.length - 1];
	}

	/** Snapshot the working tree (tracked and untracked, respecting .gitignore). */
	snapshot(label: string): Checkpoint | undefined {
		const tree = writeWorkingTree(this.cwd);
		if (!tree) return undefined;
		if (this.latest?.tree === tree) return this.latest;
		const head = git(this.cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
		const parents = head.ok ? ["-p", head.stdout.trim()] : [];
		const commit = git(this.cwd, ["commit-tree", tree, ...parents, "-m", `midnight.server checkpoint: ${label}`], {
			GIT_AUTHOR_NAME: "midnight.server",
			GIT_AUTHOR_EMAIL: "harness@midnight.server",
			GIT_COMMITTER_NAME: "midnight.server",
			GIT_COMMITTER_EMAIL: "harness@midnight.server",
		});
		if (!commit.ok) return undefined;
		const ref = `${REF_PREFIX}/${this.sessionTag}-${++this.counter}`;
		if (!git(this.cwd, ["update-ref", ref, commit.stdout.trim()]).ok) return undefined;
		const checkpoint = { ref, commit: commit.stdout.trim(), tree, createdAt: Date.now(), label };
		this.checkpoints.push(checkpoint);
		return checkpoint;
	}

	/**
	 * Restore the working tree to `checkpoint` for the paths in `only` (absolute) that differ
	 * from it. Other paths are never touched: a snapshot covers the whole repository, and the
	 * user may have changed files the agent did not. Returns the reverted change as a bounded
	 * diff (checkpoint -> state before restoring) and the restored paths as given in `only`,
	 * or undefined when nothing differed or git failed.
	 */
	restore(checkpoint: Checkpoint, only: readonly string[]): { diff: string; paths: string[] } | undefined {
		const allowed = new Map(only.map((path) => [pathKey(path), path]));
		if (allowed.size === 0) return undefined;
		const root = repoRoot(this.cwd);
		const current = writeWorkingTree(this.cwd);
		if (!root || !current || current === checkpoint.tree) return undefined;
		const names = git(root, ["diff", "--name-status", "-z", "--no-renames", checkpoint.tree, current]);
		if (!names.ok) return undefined;
		const fields = names.stdout.split("\0").filter(Boolean);
		const selected: string[] = [];
		const paths: string[] = [];
		for (let index = 0; index + 1 < fields.length; index += 2) {
			const status = fields[index];
			const path = fields[index + 1];
			const target = join(root, path);
			const requested = allowed.get(pathKey(target));
			if (requested === undefined) continue;
			selected.push(path);
			paths.push(requested);
			if (status === "A") {
				rmSync(target, { force: true });
				continue;
			}
			const blob = spawnSync("git", ["cat-file", "blob", `${checkpoint.tree}:${path}`], {
				cwd: root,
				maxBuffer: 256 * 1024 * 1024,
				windowsHide: true,
			});
			if (blob.status !== 0) continue;
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, blob.stdout);
		}
		if (selected.length === 0) return undefined;
		const diff = git(root, [
			"--literal-pathspecs",
			"diff",
			"--no-color",
			"--no-renames",
			checkpoint.tree,
			current,
			"--",
			...selected,
		]);
		const text = diff.stdout;
		return {
			diff: text.length > MAX_DIFF_BYTES ? `${text.slice(0, MAX_DIFF_BYTES)}\n[... diff truncated ...]` : text,
			paths,
		};
	}

	/** Delete this session's refs. The objects are left for git's normal garbage collection. */
	dispose(): void {
		for (const checkpoint of this.checkpoints) git(this.cwd, ["update-ref", "-d", checkpoint.ref]);
		this.checkpoints.length = 0;
	}
}

/**
 * Comparable form of an absolute path: symlinks and Windows short names resolved (git reports
 * the real repository root), and case folded on Windows. A deleted file resolves through its
 * directory.
 */
function pathKey(path: string): string {
	let key = resolve(path);
	try {
		key = realpathSync.native(key);
	} catch {
		try {
			key = join(realpathSync.native(dirname(key)), basename(key));
		} catch {
			// Keep the resolved path.
		}
	}
	return process.platform === "win32" ? key.toLowerCase() : key;
}

/** Files larger than this are left out of a change inventory: not source a detector can read. */
const MAX_INVENTORY_FILE_BYTES = 512_000;
const MAX_INVENTORY_FILES = 200;

/**
 * Every file that differs between the tree `base` (from `writeWorkingTree`) and the working
 * tree now, with both contents: edits through tools and shell commands alike. Paths are
 * repository-relative. Undefined when git fails.
 */
export function workingTreeChanges(
	cwd: string,
	base: string,
): Array<{ path: string; before: string | undefined; after: string | undefined }> | undefined {
	const root = repoRoot(cwd);
	const current = writeWorkingTree(cwd);
	if (!root || !current) return undefined;
	if (current === base) return [];
	const names = git(root, ["diff", "--name-status", "-z", "--no-renames", base, current]);
	if (!names.ok) return undefined;
	const fields = names.stdout.split("\0").filter(Boolean);
	const blob = (tree: string, path: string): string | undefined => {
		const size = git(root, ["cat-file", "-s", `${tree}:${path}`]);
		if (!size.ok || Number(size.stdout.trim()) > MAX_INVENTORY_FILE_BYTES) return undefined;
		const content = git(root, ["cat-file", "blob", `${tree}:${path}`]);
		return content.ok && !content.stdout.includes("\0") ? content.stdout : undefined;
	};
	const changes: Array<{ path: string; before: string | undefined; after: string | undefined }> = [];
	for (let index = 0; index + 1 < fields.length && changes.length < MAX_INVENTORY_FILES; index += 2) {
		const [status, path] = [fields[index], fields[index + 1]];
		// Installed dependencies and build output would crowd the agent's own changes out of the cap.
		if (isGeneratedPath(path)) continue;
		const before = status === "A" ? undefined : blob(base, path);
		const after = status === "D" ? undefined : blob(current, path);
		// A binary or oversized side is unreadable, not added or deleted: leave the file out.
		if ((status !== "A" && before === undefined) || (status !== "D" && after === undefined)) continue;
		changes.push({ path, before, after });
	}
	return changes;
}

/** The repository root, for mapping `workingTreeChanges` paths. */
export function gitRoot(cwd: string): string | undefined {
	return repoRoot(cwd);
}

/** Write the working tree to a git tree object through a throwaway index. */
export function writeWorkingTree(cwd: string): string | undefined {
	const root = repoRoot(cwd);
	if (!root) return undefined;
	const indexFile = join(
		tmpdir(),
		`midnight-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	const env = { GIT_INDEX_FILE: indexFile };
	try {
		const head = git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
		if (!git(root, head.ok ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], env).ok) return undefined;
		if (!git(root, ["add", "-A", "--", "."], env).ok) return undefined;
		const tree = git(root, ["write-tree"], env);
		return tree.ok ? tree.stdout.trim() : undefined;
	} finally {
		try {
			unlinkSync(indexFile);
		} catch {
			// Never created.
		}
	}
}
