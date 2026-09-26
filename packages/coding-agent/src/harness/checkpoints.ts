import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Snapshots of the working tree in private git refs, and restoring one.
 *
 * Problem: after a fix fails its checks twice, a weak model tends to pile a third fix on the
 * first two instead of reconsidering. The files drift further from any working state.
 *
 * Solution: each time the checks pass, the harness snapshots the working tree. When the same
 * checks then fail twice in a row, it restores the last passing snapshot and shows the model
 * the change it reverted, so the next attempt starts from working code with the failed idea
 * in view.
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
	 * Restore the working tree to `checkpoint` for every path that differs from it. Returns
	 * the reverted change as a bounded diff (checkpoint -> state before restoring), or
	 * undefined when nothing differed or git failed.
	 */
	restore(checkpoint: Checkpoint): { diff: string; paths: string[] } | undefined {
		const root = repoRoot(this.cwd);
		const current = writeWorkingTree(this.cwd);
		if (!root || !current || current === checkpoint.tree) return undefined;
		const names = git(root, ["diff", "--name-status", "-z", "--no-renames", checkpoint.tree, current]);
		if (!names.ok) return undefined;
		const diff = git(root, ["diff", "--no-color", "--no-renames", checkpoint.tree, current]);
		const fields = names.stdout.split("\0").filter(Boolean);
		const paths: string[] = [];
		for (let index = 0; index + 1 < fields.length; index += 2) {
			const status = fields[index];
			const path = fields[index + 1];
			paths.push(path);
			const target = join(root, path);
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

/** Write the working tree to a git tree object through a throwaway index. */
function writeWorkingTree(cwd: string): string | undefined {
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
