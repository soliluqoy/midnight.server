import { execFile, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, rm, unlink, writeFile } from "node:fs/promises";
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
 *
 * Every git call here is asynchronous: these run at the start of each request, after each
 * passing check and when a run settles, and a synchronous child process freezes the TUI
 * (no rendering, no input) for as long as git takes.
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

interface GitResult {
	ok: boolean;
	stdout: string;
}

function gitBuffer(
	cwd: string,
	args: string[],
	options: { env?: Record<string, string>; input?: string } = {},
): Promise<{ ok: boolean; stdout: Buffer }> {
	return new Promise((done) => {
		const child = execFile(
			"git",
			args,
			{
				cwd,
				encoding: "buffer",
				env: options.env ? { ...process.env, ...options.env } : process.env,
				maxBuffer: 256 * 1024 * 1024,
				windowsHide: true,
				timeout: 60_000,
			},
			(error, stdout) => done({ ok: !error, stdout: stdout ?? Buffer.alloc(0) }),
		);
		// git may exit before reading all of its input (a bad repository): not an error of ours.
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(options.input ?? "");
	});
}

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<GitResult> {
	const result = await gitBuffer(cwd, args, { env });
	return { ok: result.ok, stdout: result.stdout.toString("utf8") };
}

export async function isGitWorkTree(cwd: string): Promise<boolean> {
	const result = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	return result.ok && result.stdout.trim() === "true";
}

/**
 * Blob contents for `tree:path` specs, in one `git cat-file --batch` process instead of one per
 * file: on Windows each git process costs tens of milliseconds, and an inventory can read
 * hundreds of blobs. Blobs larger than `maxBytes` and missing ones map to undefined.
 */
async function readBlobs(root: string, specs: readonly string[], maxBytes: number): Promise<Map<string, Buffer>> {
	const blobs = new Map<string, Buffer>();
	// A spec is one input line: a path with a line break cannot be named, so it is left out.
	const named = [...new Set(specs)].filter((spec) => !/[\r\n]/.test(spec));
	if (named.length === 0) return blobs;
	const sizes = await gitBuffer(root, ["cat-file", "--batch-check=%(objectsize)"], {
		input: `${named.join("\n")}\n`,
	});
	if (!sizes.ok) return blobs;
	const small = sizes.stdout
		.toString("utf8")
		.split("\n")
		.slice(0, named.length)
		.flatMap((line, index) => (/^\d+$/.test(line) && Number(line) <= maxBytes ? [named[index]!] : []));
	if (small.length === 0) return blobs;
	const batch = await gitBuffer(root, ["cat-file", "--batch=%(objectsize)"], { input: `${small.join("\n")}\n` });
	if (!batch.ok) return blobs;
	// Each object is "<size>\n<content>\n"; a missing one is "<spec> missing\n".
	const out = batch.stdout;
	let offset = 0;
	for (const spec of small) {
		const end = out.indexOf(0x0a, offset);
		if (end === -1) break;
		const header = out.subarray(offset, end).toString("utf8");
		offset = end + 1;
		if (!/^\d+$/.test(header)) continue;
		const size = Number(header);
		blobs.set(spec, out.subarray(offset, offset + size));
		offset += size + 1;
	}
	return blobs;
}

/**
 * The repository root, spelled like `cwd`. `--show-toplevel` returns git's canonical long path, so
 * with an 8.3 short-path cwd on Windows (`C:\Users\RUNNER~1\...`, as TEMP often is) every changed
 * path mapped back from it would look outside the workspace. `--show-cdup` is relative to `cwd`.
 */
async function repoRoot(cwd: string): Promise<string | undefined> {
	const result = await git(cwd, ["rev-parse", "--show-cdup"]);
	return result.ok ? resolve(cwd, result.stdout.trim()) : undefined;
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
	async snapshot(label: string): Promise<Checkpoint | undefined> {
		const tree = await writeWorkingTree(this.cwd);
		if (!tree) return undefined;
		if (this.latest?.tree === tree) return this.latest;
		const head = await git(this.cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
		const parents = head.ok ? ["-p", head.stdout.trim()] : [];
		const commit = await git(
			this.cwd,
			["commit-tree", tree, ...parents, "-m", `midnight.server checkpoint: ${label}`],
			{
				GIT_AUTHOR_NAME: "midnight.server",
				GIT_AUTHOR_EMAIL: "harness@midnight.server",
				GIT_COMMITTER_NAME: "midnight.server",
				GIT_COMMITTER_EMAIL: "harness@midnight.server",
			},
		);
		if (!commit.ok) return undefined;
		const ref = `${REF_PREFIX}/${this.sessionTag}-${++this.counter}`;
		if (!(await git(this.cwd, ["update-ref", ref, commit.stdout.trim()])).ok) return undefined;
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
	async restore(
		checkpoint: Checkpoint,
		only: readonly string[],
	): Promise<{ diff: string; paths: string[] } | undefined> {
		const allowed = new Map(only.map((path) => [pathKey(path), path]));
		if (allowed.size === 0) return undefined;
		const [root, current] = await Promise.all([repoRoot(this.cwd), writeWorkingTree(this.cwd)]);
		if (!root || !current || current === checkpoint.tree) return undefined;
		const names = await git(root, ["diff", "--name-status", "-z", "--no-renames", checkpoint.tree, current]);
		if (!names.ok) return undefined;
		const fields = names.stdout.split("\0").filter(Boolean);
		const selected: Array<{ status: string; path: string; target: string }> = [];
		const paths: string[] = [];
		for (let index = 0; index + 1 < fields.length; index += 2) {
			const status = fields[index]!;
			const path = fields[index + 1]!;
			const target = join(root, path);
			const requested = allowed.get(pathKey(target));
			if (requested === undefined) continue;
			selected.push({ status, path, target });
			paths.push(requested);
		}
		if (selected.length === 0) return undefined;
		const blobs = await readBlobs(
			root,
			selected.filter((item) => item.status !== "A").map((item) => `${checkpoint.tree}:${item.path}`),
			Number.POSITIVE_INFINITY,
		);
		for (const { status, path, target } of selected) {
			if (status === "A") {
				await rm(target, { force: true });
				continue;
			}
			const blob = blobs.get(`${checkpoint.tree}:${path}`);
			if (!blob) continue;
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, blob);
		}
		const diff = await git(root, [
			"--literal-pathspecs",
			"diff",
			"--no-color",
			"--no-renames",
			checkpoint.tree,
			current,
			"--",
			...selected.map((item) => item.path),
		]);
		const text = diff.stdout;
		return {
			diff: text.length > MAX_DIFF_BYTES ? `${text.slice(0, MAX_DIFF_BYTES)}\n[... diff truncated ...]` : text,
			paths,
		};
	}

	/**
	 * Delete this session's refs. The objects are left for git's normal garbage collection. This
	 * runs at shutdown, where an asynchronous call could be cut off, so it is one synchronous git
	 * process for all refs.
	 */
	dispose(): void {
		if (this.checkpoints.length === 0) return;
		spawnSync("git", ["update-ref", "--stdin"], {
			cwd: this.cwd,
			input: this.checkpoints.map((checkpoint) => `delete ${checkpoint.ref}\n`).join(""),
			stdio: ["pipe", "ignore", "ignore"],
			windowsHide: true,
			timeout: 10_000,
		});
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
export async function workingTreeChanges(
	cwd: string,
	base: string,
): Promise<Array<{ path: string; before: string | undefined; after: string | undefined }> | undefined> {
	const [root, current] = await Promise.all([repoRoot(cwd), writeWorkingTree(cwd)]);
	if (!root || !current) return undefined;
	if (current === base) return [];
	const names = await git(root, ["diff", "--name-status", "-z", "--no-renames", base, current]);
	if (!names.ok) return undefined;
	const fields = names.stdout.split("\0").filter(Boolean);
	const candidates: Array<{ status: string; path: string }> = [];
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const path = fields[index + 1]!;
		// Installed dependencies and build output would crowd the agent's own changes out of the cap.
		if (!isGeneratedPath(path)) candidates.push({ status: fields[index]!, path });
	}
	const specs = candidates.flatMap(({ status, path }) => [
		...(status === "A" ? [] : [`${base}:${path}`]),
		...(status === "D" ? [] : [`${current}:${path}`]),
	]);
	const blobs = await readBlobs(root, specs, MAX_INVENTORY_FILE_BYTES);
	const text = (spec: string): string | undefined => {
		const blob = blobs.get(spec);
		return blob && !blob.includes(0) ? blob.toString("utf8") : undefined;
	};
	const changes: Array<{ path: string; before: string | undefined; after: string | undefined }> = [];
	for (const { status, path } of candidates) {
		if (changes.length >= MAX_INVENTORY_FILES) break;
		const before = status === "A" ? undefined : text(`${base}:${path}`);
		const after = status === "D" ? undefined : text(`${current}:${path}`);
		// A binary or oversized side is unreadable, not added or deleted: leave the file out.
		if ((status !== "A" && before === undefined) || (status !== "D" && after === undefined)) continue;
		changes.push({ path, before, after });
	}
	return changes;
}

/** The repository root, for mapping `workingTreeChanges` paths. */
export function gitRoot(cwd: string): Promise<string | undefined> {
	return repoRoot(cwd);
}

/**
 * Write the working tree to a git tree object through a throwaway index. The throwaway index
 * starts as a copy of the repository's own index: its stat cache lets `git add -A` skip every
 * unchanged file instead of rehashing the whole tree (seconds on a large repository, and this
 * runs at the start of each request). `add -A` then makes it match the working tree, so staged
 * changes in the user's index do not leak into the result.
 */
export async function writeWorkingTree(cwd: string): Promise<string | undefined> {
	const info = await git(cwd, ["rev-parse", "--show-cdup", "--git-path", "index"]);
	if (!info.ok) return undefined;
	const [cdup = "", gitIndex = ""] = info.stdout.split(/\r?\n/);
	const root = resolve(cwd, cdup.trim());
	const indexFile = join(
		tmpdir(),
		`midnight-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	const env = { GIT_INDEX_FILE: indexFile };
	try {
		let seeded = false;
		try {
			if (gitIndex.trim()) {
				await copyFile(resolve(cwd, gitIndex.trim()), indexFile);
				seeded = true;
			}
		} catch {
			// No index yet (fresh repository): start from HEAD or empty.
		}
		if (!seeded) {
			const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
			if (!(await git(root, head.ok ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], env)).ok) return undefined;
		}
		if (!(await git(root, ["add", "-A", "--", "."], env)).ok) return undefined;
		const tree = await git(root, ["write-tree"], env);
		return tree.ok ? tree.stdout.trim() : undefined;
	} finally {
		try {
			await unlink(indexFile);
		} catch {
			// Never created.
		}
	}
}
