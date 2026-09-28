import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, stat, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { isGeneratedPath } from "./workspace.ts";

/**
 * Git helpers for the harness: the working tree as a git tree object, what changed since one, and
 * a throwaway copy of one for checks that must see the tree as a request found it.
 *
 * Every git call here is asynchronous: a synchronous child process freezes the TUI (no rendering,
 * no input) for as long as git takes. The user's index, branches, HEAD and stash are never touched.
 */

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

/** Ignored files copied into a materialized tree at most this large (a `.env`, a local config). */
const MAX_IGNORED_COPY_BYTES = 1_000_000;

export interface MaterializedTree {
	/** Where `cwd` is inside the copy: run checks here. */
	cwd: string;
	/** The copy's repository root, to map paths in check output back to the real one. */
	root: string;
	/** Remove the copy. Links are removed as links; their targets are never touched. */
	dispose(): Promise<void>;
}

/**
 * Write the tree `tree` (from `writeWorkingTree`) to a temporary directory, so a check can run
 * against the files as they were when a request started without touching the working tree.
 * Ignored paths (installed dependencies, build output, local config) are not in the tree; they
 * are linked (directories) or copied (small files) from the real checkout, so a type check still
 * resolves its dependencies. Undefined when git fails.
 */
export async function materializeTree(cwd: string, tree: string): Promise<MaterializedTree | undefined> {
	const root = await repoRoot(cwd);
	if (!root) return undefined;
	const dir = await mkdtemp(join(tmpdir(), "midnight-baseline-"));
	const links: string[] = [];
	const dispose = async () => {
		for (const link of links) await unlink(link).catch(() => undefined);
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	};
	const indexFile = join(
		tmpdir(),
		`midnight-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	const env = { GIT_INDEX_FILE: indexFile };
	try {
		const ok =
			(await git(root, ["read-tree", tree], env)).ok &&
			(await git(root, ["checkout-index", "-a", "-f", `--prefix=${dir}/`], env)).ok;
		if (!ok) {
			await dispose();
			return undefined;
		}
	} finally {
		await unlink(indexFile).catch(() => undefined);
	}
	const ignored = await git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
	if (ignored.ok) {
		for (const entry of ignored.stdout.split("\0").filter(Boolean)) {
			const isDir = entry.endsWith("/");
			const path = entry.replace(/\/$/, "");
			const source = resolve(root, path);
			const target = resolve(dir, path);
			try {
				await mkdir(dirname(target), { recursive: true });
				if (isDir) {
					await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
					links.push(target);
				} else {
					const { size } = await stat(source);
					if (size <= MAX_IGNORED_COPY_BYTES) await copyFile(source, target);
				}
			} catch {
				// Unlinkable or unreadable: the check may fail on it, and then it is not a usable baseline.
			}
		}
	}
	return { cwd: resolve(dir, relative(root, cwd)), root: dir, dispose };
}
