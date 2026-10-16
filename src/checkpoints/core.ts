import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, realpath, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const REF_BASE = "refs/midnight/checkpoints";
export const MAX_PATHS = 10000;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT = 16 * 1024 * 1024;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IGNORED = new Set([
	"node_modules",
	".git",
	".venv",
	"venv",
	"dist",
	"build",
	".cache",
	".artifacts",
	"__pycache__",
]);

export interface Checkpoint {
	version: 1;
	id: string;
	sessionId: string;
	entryId: string | null;
	contextRevision: number | null;
	trigger: "resume" | "turn" | "before-restore" | "manual";
	timestamp: number;
	branch: string;
	head: string | null;
	indexTree: string;
	worktreeTree: string;
	covered: string[];
	excluded: { path: string; reason: string }[];
	scope: string[];
}
export interface StoredCheckpoint extends Checkpoint {
	ref: string;
	commit: string;
}
interface TreeEntry {
	mode: string;
	sha: string;
}
type SpoolBlob = Readonly<{ path: string; expectedOid: string }>;
export interface RestorePlan {
	target: StoredCheckpoint;
	paths: string[];
	fingerprint: string;
	changes: { path: string; worktree: boolean; index: boolean; deletion: boolean }[];
}
export interface CaptureOptions {
	sessionId: string;
	entryId?: string | null;
	contextRevision?: number | null;
	trigger?: Checkpoint["trigger"];
	scope?: readonly string[];
	previous?: StoredCheckpoint;
	deduplicate?: boolean;
	signal?: AbortSignal;
	recovery?: string;
}

export class CheckpointGitError extends Error {
	readonly exitCode: number | null;
	constructor(message: string, exitCode: number | null) {
		super(message);
		this.exitCode = exitCode;
	}
}

export function git(
	root: string,
	args: readonly string[],
	options: { input?: string | Buffer; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<Buffer> {
	options.signal?.throwIfAborted();
	return new Promise((done, fail) => {
		const proc = spawn("git", ["--no-optional-locks", ...args], {
			cwd: root,
			windowsHide: true,
			env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", ...options.env },
			signal: options.signal,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let bytes = 0;
		let stderr = "";
		let problem: Error | undefined;
		const timer = setTimeout(() => {
			problem = new Error("Checkpoint Git operation timed out.");
			proc.kill();
		}, 15000);
		proc.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_OUTPUT) {
				problem = new Error("Checkpoint Git output exceeds its bounded limit.");
				proc.kill();
			} else chunks.push(chunk);
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-8192);
		});
		proc.on("error", (error) => {
			clearTimeout(timer);
			fail(error);
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (problem || code !== 0)
				fail(problem ?? new CheckpointGitError(stderr.trim() || `Git ${args[0]} failed (${code}).`, code));
			else done(Buffer.concat(chunks));
		});
		proc.stdin.on("error", () => {});
		proc.stdin.end(options.input);
	});
}
async function text(root: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
	return (await git(root, args, { signal })).toString("utf8").trim();
}
export async function repositoryRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	return realpath(await text(cwd, ["rev-parse", "--show-toplevel"], signal));
}
export function safePath(path: string): boolean {
	return (
		Boolean(path) &&
		!isAbsolute(path) &&
		!path.includes("\0") &&
		!path.includes("\\") &&
		!path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") &&
		!/^[a-z]:/i.test(path)
	);
}
export function exclusion(path: string): string | undefined {
	if (!safePath(path)) return "unsafe path";
	if (path.split("/").some((part) => IGNORED.has(part.toLowerCase()))) return "excluded directory";
	if (/(^|\/)(?:\.env(?:\..*)?|credentials(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/i.test(path))
		return "sensitive path";
	return undefined;
}
function nul(buffer: Buffer): string[] {
	return buffer.toString("utf8").split("\0").filter(Boolean);
}
function hash(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}
function namespace(sessionId: string): string {
	return `${REF_BASE}/${hash(sessionId).slice(0, 24)}`;
}
async function gitPath(root: string, name: string): Promise<string> {
	return resolve(root, await text(root, ["rev-parse", "--git-path", name]));
}
async function head(root: string, signal?: AbortSignal): Promise<{ branch: string; head: string | null }> {
	const branch = await text(root, ["symbolic-ref", "--quiet", "HEAD"], signal).catch((error: unknown) => {
		if (error instanceof CheckpointGitError && error.exitCode === 1) return "detached";
		throw error;
	});
	const commit = await text(root, ["rev-parse", "--verify", "--quiet", "HEAD"], signal).catch((error: unknown) => {
		if (branch !== "detached" && error instanceof CheckpointGitError && error.exitCode === 1) return null;
		throw error;
	});
	if (commit !== null && !SHA.test(commit)) throw new Error("Invalid HEAD object.");
	return { branch, head: commit };
}
async function temporaryIndex(root: string): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
	const dir = await mkdtemp(join(tmpdir(), "midnight-checkpoint-"));
	const index = join(dir, "index");
	const source = await gitPath(root, "index");
	try {
		await copyFile(source, index);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			await rm(dir, { recursive: true, force: true });
			throw error;
		}
	}
	return { dir, env: { GIT_INDEX_FILE: index } };
}
async function tree(root: string, sha: string): Promise<Map<string, TreeEntry>> {
	if (!SHA.test(sha)) throw new Error("Invalid tree object.");
	const entries = new Map<string, TreeEntry>();
	for (const record of nul(await git(root, ["ls-tree", "-rz", "--full-tree", sha]))) {
		const tab = record.indexOf("\t");
		const [mode, type, oid] = record.slice(0, tab).split(" ");
		const path = record.slice(tab + 1);
		if (tab < 0 || !SHA.test(oid) || !safePath(path)) throw new Error("Unsafe snapshot tree.");
		if (type !== "blob" && type !== "commit") throw new Error("Unsupported snapshot entry.");
		entries.set(path, { mode, sha: oid });
	}
	return entries;
}
async function filePath(root: string, path: string): Promise<string> {
	if (!safePath(path)) throw new Error(`Unsafe checkpoint path: ${JSON.stringify(path)}`);
	let parent = root;
	for (const component of path.split("/").slice(0, -1)) {
		parent = join(parent, component);
		try {
			const info = await lstat(parent);
			if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Checkpoint parent is not a real directory.");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const target = resolve(root, path);
	const rel = relative(root, target);
	if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Checkpoint path escapes the project.");
	return target;
}
async function inspectFile(root: string, path: string): Promise<{ data: Buffer; mode: string } | null> {
	const target = await filePath(root, path);
	let info: Stats;
	try {
		info = await lstat(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("Non-regular file or symlink is not covered.");
	if (info.size > MAX_FILE_BYTES) throw new Error("File exceeds 10 MiB.");
	const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const data = await handle.readFile();
		const after = await handle.stat();
		if (
			data.length > MAX_FILE_BYTES ||
			after.size !== info.size ||
			after.mtimeMs !== info.mtimeMs ||
			after.ino !== info.ino
		)
			throw new Error("File changed while being captured.");
		return { data, mode: process.platform === "win32" ? "100644" : info.mode & 0o111 ? "100755" : "100644" };
	} finally {
		await handle.close();
	}
}
async function indexTree(root: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
	const conflicts = await git(root, ["ls-files", "--unmerged", "-z"], { env, signal });
	if (conflicts.length) throw new Error("Resolve Git index conflicts before taking or restoring a checkpoint.");
	return (await git(root, ["write-tree"], { env, signal })).toString("utf8").trim();
}
function indexRecord(path: string, entry?: TreeEntry, zero = "0".repeat(40)): string {
	return `${entry ? `${entry.mode} ${entry.sha}` : `0 ${zero}`}\t${path}\0`;
}
async function lock<T>(root: string, operation: () => Promise<T>): Promise<T> {
	const path = await gitPath(root, "midnight-checkpoints.lock");
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error("Another checkpoint operation owns this worktree. A leftover lock requires manual inspection.");
		throw error;
	}
	try {
		await handle.writeFile(JSON.stringify({ pid: process.pid, created: Date.now() }));
		return await operation();
	} finally {
		await handle.close();
		await unlink(path);
	}
}
async function writeSpoolBlobs(root: string, blobs: readonly SpoolBlob[], signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	if (!blobs.length) return;
	// Git stdin-paths uses C-quoted UTF-8 filenames, not shell quoting or NUL records.
	const paths = blobs.map((blob) => {
		const path = process.platform === "win32" ? blob.path.replaceAll("\\", "/") : blob.path;
		let quoted = '"';
		for (const byte of Buffer.from(path, "utf8")) {
			quoted +=
				byte >= 32 && byte <= 126 && byte !== 34 && byte !== 92
					? String.fromCharCode(byte)
					: `\\${byte.toString(8).padStart(3, "0")}`;
		}
		return `${quoted}"\n`;
	});
	const output = await git(root, ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
		input: paths.join(""),
		signal,
	});
	const oids = output.toString("utf8").split(/\r?\n/);
	if (oids.at(-1) === "") oids.pop();
	if (
		oids.length !== blobs.length ||
		oids.some((oid, index) => !/^[a-f0-9]+$/.test(oid) || oid !== blobs[index].expectedOid)
	)
		throw new Error("Checkpoint blob batch output does not match the verified file hashes.");
}
async function captureUnlocked(root: string, options: CaptureOptions): Promise<StoredCheckpoint> {
	options.signal?.throwIfAborted();
	const before = await head(root, options.signal);
	const temp = await temporaryIndex(root);
	try {
		const stagedTree = await indexTree(root, temp.env, options.signal);
		const staged = await tree(root, stagedTree);
		const committed = before.head ? await tree(root, before.head) : new Map<string, TreeEntry>();
		const untracked = nul(
			await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], { signal: options.signal }),
		);
		let capturedBytes = 0;
		const untrackedCounts = new Map<string, number>();
		for (const path of untracked)
			if (path.includes("/")) {
				const dir = path.split("/")[0];
				untrackedCounts.set(dir, (untrackedCounts.get(dir) ?? 0) + 1);
			}
		const candidates = [
			...new Set([
				...staged.keys(),
				...committed.keys(),
				...untracked,
				...(options.previous?.covered ?? []),
				...(options.scope ?? []),
			]),
		].sort();
		const previousTree = options.previous
			? await tree(root, options.previous.worktreeTree)
			: new Map<string, TreeEntry>();
		if (candidates.length > MAX_PATHS)
			throw new Error(`Checkpoint exceeds ${MAX_PATHS} candidate paths; no incomplete checkpoint was created.`);
		const covered: string[] = [];
		const excluded: Checkpoint["excluded"] = [];
		const records: string[] = [];
		const blobs: SpoolBlob[] = [];
		for (const path of candidates) {
			options.signal?.throwIfAborted();
			let reason = exclusion(path);
			const mode = staged.get(path)?.mode ?? committed.get(path)?.mode;
			if (mode === "160000") reason = "submodule";
			if (mode === "120000") reason = "symlink";
			if (!staged.has(path) && (untrackedCounts.get(path.split("/")[0]) ?? 0) > 200)
				reason = "untracked directory exceeds 200 files";
			if (reason) {
				excluded.push({ path, reason });
				continue;
			}
			if (capturedBytes >= MAX_CAPTURE_BYTES) {
				excluded.push({ path, reason: "snapshot exceeds 64 MiB read budget" });
				continue;
			}
			let file: Awaited<ReturnType<typeof inspectFile>>;
			try {
				file = await inspectFile(root, path);
			} catch (error) {
				excluded.push({ path, reason: error instanceof Error ? error.message : "unavailable" });
				continue;
			}
			capturedBytes += file?.data.length ?? 0;
			if (capturedBytes > MAX_CAPTURE_BYTES) {
				excluded.push({ path, reason: "snapshot exceeds 64 MiB read budget" });
				continue;
			}
			covered.push(path);
			if (!file) {
				if (staged.has(path)) records.push(indexRecord(path, undefined, "0".repeat(stagedTree.length)));
				continue;
			}
			const digest = createHash(stagedTree.length === 64 ? "sha256" : "sha1")
				.update(`blob ${file.data.length}\0`)
				.update(file.data)
				.digest("hex");
			const known = [staged.get(path)?.sha, committed.get(path)?.sha, previousTree.get(path)?.sha].includes(digest);
			if (!known) {
				const spoolPath = join(temp.dir, `blob-${blobs.length}`);
				const spool = await open(spoolPath, "wx", 0o600);
				try {
					await spool.writeFile(file.data);
				} finally {
					await spool.close();
				}
				blobs.push({ path: spoolPath, expectedOid: digest });
			}
			const fileMode =
				process.platform === "win32" ? (staged.get(path)?.mode ?? committed.get(path)?.mode ?? file.mode) : file.mode;
			if (staged.get(path)?.sha !== digest || staged.get(path)?.mode !== fileMode)
				records.push(indexRecord(path, { mode: fileMode, sha: digest }));
		}
		await writeSpoolBlobs(root, blobs, options.signal);
		if (records.length)
			await git(root, ["update-index", "-z", "--index-info"], {
				env: temp.env,
				input: records.join(""),
				signal: options.signal,
			});
		const worktreeTree = records.length
			? (await git(root, ["write-tree"], { env: temp.env, signal: options.signal })).toString("utf8").trim()
			: stagedTree;
		const after = await head(root, options.signal);
		if (JSON.stringify(before) !== JSON.stringify(after))
			throw new Error("HEAD changed while capturing the checkpoint.");
		const verify = await temporaryIndex(root);
		try {
			if ((await indexTree(root, verify.env, options.signal)) !== stagedTree)
				throw new Error("Index changed while capturing the checkpoint.");
		} finally {
			await rm(verify.dir, { recursive: true, force: true });
		}
		const observed: string[] = [];
		if (options.previous) {
			for (const [from, to] of [
				[options.previous.worktreeTree, worktreeTree],
				[options.previous.indexTree, stagedTree],
			]) {
				if (from !== to)
					observed.push(
						...nul(
							await git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", from, to], {
								signal: options.signal,
							}),
						),
					);
			}
		}
		const cp: Checkpoint = {
			version: 1,
			id: randomUUID(),
			sessionId: options.sessionId,
			entryId: options.entryId ?? null,
			contextRevision: options.contextRevision ?? null,
			trigger: options.trigger ?? "turn",
			timestamp: Date.now(),
			...before,
			indexTree: stagedTree,
			worktreeTree,
			covered,
			excluded,
			scope: [...new Set([...(options.scope ?? []), ...observed])].filter(
				(path) => !exclusion(path) && !excluded.some((e) => e.path === path),
			),
		};
		const previous = options.previous;
		if (
			options.deduplicate &&
			previous &&
			cp.trigger !== "before-restore" &&
			previous.trigger !== "before-restore" &&
			previous.sessionId === cp.sessionId &&
			previous.head === cp.head &&
			previous.branch === cp.branch &&
			previous.indexTree === cp.indexTree &&
			previous.worktreeTree === cp.worktreeTree &&
			JSON.stringify(previous.scope) === JSON.stringify(cp.scope) &&
			JSON.stringify(previous.covered) === JSON.stringify(cp.covered) &&
			JSON.stringify(previous.excluded) === JSON.stringify(cp.excluded)
		) {
			const commit = await text(root, ["rev-parse", "--verify", "--quiet", previous.ref], options.signal).catch(
				(error: unknown) => {
					if (error instanceof CheckpointGitError && error.exitCode === 1) return null;
					throw error;
				},
			);
			if (commit === previous.commit) return previous;
		}
		return await persistCheckpoint(root, cp, options.signal);
	} finally {
		await rm(temp.dir, { recursive: true, force: true });
	}
}
async function persistCheckpoint(root: string, cp: Checkpoint, signal?: AbortSignal): Promise<StoredCheckpoint> {
	if (!validCheckpoint(cp)) throw new Error("Invalid checkpoint metadata before persistence.");
	const input = JSON.stringify(cp);
	if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("Checkpoint metadata exceeds 1 MiB.");
	const identity = {
		GIT_AUTHOR_NAME: "Midnight",
		GIT_AUTHOR_EMAIL: "checkpoint@midnight.local",
		GIT_COMMITTER_NAME: "Midnight",
		GIT_COMMITTER_EMAIL: "checkpoint@midnight.local",
	};
	const indexCommit = (
		await git(root, ["commit-tree", cp.indexTree], {
			input: "Midnight staged snapshot",
			env: identity,
			signal: signal,
		})
	)
		.toString("utf8")
		.trim();
	const commit = (
		await git(root, ["commit-tree", cp.worktreeTree, "-p", indexCommit], {
			input,
			env: identity,
			signal: signal,
		})
	)
		.toString("utf8")
		.trim();
	const ref = `${namespace(cp.sessionId)}/${cp.id}`;
	await git(root, ["update-ref", ref, commit], { signal: signal });
	return { ...cp, ref, commit };
}
export async function storeImportedCheckpoint(root: string, cp: Checkpoint): Promise<StoredCheckpoint> {
	return lock(root, () => persistCheckpoint(root, cp));
}

export async function captureCheckpoint(root: string, options: CaptureOptions): Promise<StoredCheckpoint> {
	return lock(root, () => captureUnlocked(root, options));
}
function validCheckpoint(value: unknown): value is Checkpoint {
	if (!value || typeof value !== "object") return false;
	const cp = value as Partial<Checkpoint>;
	const paths = (value: unknown): value is string[] =>
		Array.isArray(value) && value.length <= MAX_PATHS && value.every((p) => typeof p === "string" && safePath(p));
	return (
		cp.version === 1 &&
		typeof cp.id === "string" &&
		/^[a-f0-9-]{36}$/.test(cp.id) &&
		typeof cp.sessionId === "string" &&
		cp.sessionId.length < 512 &&
		(cp.entryId === null || typeof cp.entryId === "string") &&
		(cp.contextRevision === null || (Number.isSafeInteger(cp.contextRevision) && Number(cp.contextRevision) >= 0)) &&
		["resume", "turn", "before-restore", "manual"].includes(cp.trigger ?? "") &&
		Number.isFinite(cp.timestamp) &&
		typeof cp.branch === "string" &&
		cp.branch.length < 1024 &&
		(cp.head === null || (typeof cp.head === "string" && SHA.test(cp.head))) &&
		typeof cp.indexTree === "string" &&
		SHA.test(cp.indexTree) &&
		typeof cp.worktreeTree === "string" &&
		SHA.test(cp.worktreeTree) &&
		paths(cp.covered) &&
		paths(cp.scope) &&
		cp.scope.every((p) => cp.covered?.includes(p)) &&
		Array.isArray(cp.excluded) &&
		cp.excluded.length <= MAX_PATHS &&
		cp.excluded.every((e) => e && typeof e.path === "string" && typeof e.reason === "string")
	);
}
export async function loadCheckpoints(
	root: string,
	refs: readonly string[],
	signal?: AbortSignal,
): Promise<Map<string, StoredCheckpoint | Error>> {
	signal?.throwIfAborted();
	const result = new Map<string, StoredCheckpoint | Error>();
	const valid: string[] = [];
	for (const ref of new Set(refs)) {
		if (/^refs\/midnight\/checkpoints\/[a-f0-9]{24}\/[a-f0-9-]{36}$/.test(ref)) valid.push(ref);
		else result.set(ref, new Error("Invalid checkpoint reference."));
	}
	for (let start = 0; start < valid.length; start += 8) {
		const batch = valid.slice(start, start + 8);
		const raw = await git(root, ["cat-file", "--batch"], { input: `${batch.join("\n")}\n`, signal });
		const pending: { cp: StoredCheckpoint; parent: string }[] = [];
		let offset = 0;
		for (const ref of batch) {
			signal?.throwIfAborted();
			const end = raw.indexOf(10, offset);
			if (end < 0) throw new Error("Incomplete checkpoint batch header.");
			const header = raw.toString("utf8", offset, end);
			offset = end + 1;
			if (header === `${ref} missing`) {
				result.set(ref, new Error("Checkpoint reference is unavailable or pruned."));
				continue;
			}
			const [commit, type, sizeText] = header.split(" ");
			const size = Number(sizeText);
			if (!SHA.test(commit) || !Number.isSafeInteger(size) || size < 0 || raw[offset + size] !== 10)
				throw new Error("Invalid checkpoint batch framing.");
			const content = raw.subarray(offset, offset + size);
			offset += size + 1;
			try {
				if (type !== "commit") throw new Error("Checkpoint reference is not a commit.");
				const separator = content.indexOf("\n\n");
				if (separator < 0) throw new Error("Invalid checkpoint commit.");
				const body = content.subarray(separator + 2);
				if (body.length > 1024 * 1024) throw new Error("Checkpoint metadata exceeds 1 MiB.");
				const cp: unknown = JSON.parse(body.toString("utf8"));
				if (!validCheckpoint(cp) || ref !== `${namespace(cp.sessionId)}/${cp.id}`)
					throw new Error("Invalid checkpoint metadata.");
				const headers = content.toString("utf8", 0, separator);
				const graph = /^tree ([a-f0-9]+)\nparent ([a-f0-9]+)(?:\n|$)/.exec(headers);
				if (!graph || graph[1] !== cp.worktreeTree || !SHA.test(graph[2]))
					throw new Error("Checkpoint object mismatch.");
				pending.push({ cp: { ...cp, ref, commit }, parent: graph[2] });
			} catch (error) {
				result.set(ref, error instanceof Error ? error : new Error(String(error)));
			}
		}
		if (offset !== raw.length) throw new Error("Unexpected checkpoint batch data.");
		if (!pending.length) continue;
		const queries = pending.flatMap(({ cp, parent }) => [cp.worktreeTree, cp.indexTree, `${parent}^{tree}`]);
		const checked = (
			await git(root, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
				input: `${queries.join("\n")}\n`,
				signal,
			})
		)
			.toString("utf8")
			.trimEnd()
			.split("\n");
		if (checked.length !== queries.length) throw new Error("Incomplete checkpoint tree validation.");
		pending.forEach(({ cp }, i) => {
			const expected = [cp.worktreeTree, cp.indexTree, cp.indexTree];
			result.set(
				cp.ref,
				expected.every((sha, j) => checked[i * 3 + j] === `${sha} tree`)
					? cp
					: new Error("Checkpoint object mismatch."),
			);
		});
	}
	signal?.throwIfAborted();
	return result;
}
export async function loadCheckpoint(root: string, ref: string, signal?: AbortSignal): Promise<StoredCheckpoint> {
	const cp = (await loadCheckpoints(root, [ref], signal)).get(ref);
	if (!cp || cp instanceof Error) throw cp ?? new Error("Checkpoint is unavailable.");
	return cp;
}
export async function listCheckpoints(
	root: string,
	sessionId: string,
	signal?: AbortSignal,
): Promise<StoredCheckpoint[]> {
	const refs = (await text(root, ["for-each-ref", "--format=%(refname)", `${namespace(sessionId)}/`], signal))
		.split("\n")
		.filter(Boolean);
	if (refs.length > 1000) throw new Error("Too many checkpoint references; inspect retention manually.");
	const loaded = await loadCheckpoints(root, refs, signal);
	const result = refs.map((ref) => {
		const cp = loaded.get(ref);
		if (!cp || cp instanceof Error) throw cp ?? new Error("Checkpoint is unavailable.");
		return cp;
	});
	return result.sort((a, b) => a.timestamp - b.timestamp);
}
export async function pruneCheckpoints(
	root: string,
	sessionId: string,
	keep = 50,
	signal?: AbortSignal,
): Promise<void> {
	if (!Number.isSafeInteger(keep) || keep < 1) throw new Error("Invalid checkpoint retention.");
	await lock(root, async () => {
		const snapshots = await listCheckpoints(root, sessionId, signal);
		for (const cp of snapshots.filter((cp) => cp.trigger !== "before-restore").slice(0, -keep))
			await git(root, ["update-ref", "-d", cp.ref, cp.commit], { signal });
	});
}
async function currentFingerprint(
	root: string,
	paths: readonly string[],
	currentIndex: Map<string, TreeEntry>,
): Promise<string> {
	const values: string[] = [JSON.stringify(await head(root))];
	for (const path of paths) {
		const file = await inspectFile(root, path);
		values.push(JSON.stringify([path, file ? hash(file.data) : null, file?.mode, currentIndex.get(path)]));
	}
	return hash(values.join("\n"));
}
export async function prepareRestore(
	root: string,
	target: StoredCheckpoint,
	scope: readonly string[],
): Promise<RestorePlan> {
	const cp = await loadCheckpoint(root, target.ref);
	if (cp.commit !== target.commit) throw new Error("Checkpoint reference changed.");
	const now = await head(root);
	if (now.branch !== cp.branch || now.head !== cp.head)
		throw new Error("Branch or HEAD changed. Restore is refused; Midnight never rewinds Git history.");
	const paths = [...new Set(scope)].sort();
	if (paths.length > MAX_PATHS || paths.some((path) => exclusion(path))) throw new Error("Unsafe restore scope.");
	const covered = new Set(cp.covered);
	const excluded = cp.excluded.map((entry) => entry.path);
	if (paths.some((path) => excluded.some((entry) => path === entry || path.startsWith(`${entry}/`))))
		throw new Error("Restore includes an uncaptured path; incomplete coverage cannot be treated as clean.");
	const wt = await tree(root, cp.worktreeTree);
	const idx = await tree(root, cp.indexTree);
	if (paths.some((path) => !covered.has(path) && (wt.has(path) || idx.has(path))))
		throw new Error("Restore coverage does not match the snapshot.");
	const temp = await temporaryIndex(root);
	try {
		const currentIndex = await tree(root, await indexTree(root, temp.env));
		const changes: RestorePlan["changes"] = [];
		let readBytes = 0;
		for (const path of paths) {
			const file = await inspectFile(root, path);
			const desired = wt.get(path);
			if (desired && !["100644", "100755"].includes(desired.mode))
				throw new Error("Non-regular checkpoint entry cannot be restored.");
			const blob = desired ? await git(root, ["cat-file", "blob", desired.sha]) : null;
			if (blob && blob.length > MAX_FILE_BYTES) throw new Error("Restore blob exceeds 10 MiB.");
			readBytes += (blob?.length ?? 0) + (file?.data.length ?? 0);
			if (readBytes > MAX_CAPTURE_BYTES) throw new Error("Restore preview exceeds its 64 MiB read budget.");
			const worktree =
				file === null
					? desired !== undefined
					: !blob || !file.data.equals(blob) || (process.platform !== "win32" && file.mode !== desired?.mode);
			const index = JSON.stringify(idx.get(path)) !== JSON.stringify(currentIndex.get(path));
			if (worktree || index) changes.push({ path, worktree, index, deletion: !desired && file !== null });
		}
		return { target: cp, paths, changes, fingerprint: await currentFingerprint(root, paths, currentIndex) };
	} finally {
		await rm(temp.dir, { recursive: true, force: true });
	}
}
export interface RestoreRecovery {
	backup: StoredCheckpoint;
	target: string;
	paths: string[];
	fingerprint: string;
}
export async function readRestoreRecovery(root: string): Promise<RestoreRecovery | null> {
	const path = await gitPath(root, "midnight-restore.json");
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > 1024 * 1024)
			throw new Error("Invalid or oversized restore journal; inspect it manually.");
		const raw = await handle.readFile();
		if (raw.length > 1024 * 1024) throw new Error("Restore journal exceeds 1 MiB.");
		const data = JSON.parse(raw.toString("utf8")) as {
			version?: unknown;
			target?: unknown;
			backup?: unknown;
			paths?: unknown;
		};
		if (
			data.version !== 1 ||
			typeof data.target !== "string" ||
			typeof data.backup !== "string" ||
			!Array.isArray(data.paths) ||
			data.paths.length > MAX_PATHS ||
			!data.paths.every((value) => typeof value === "string" && safePath(value) && !exclusion(value))
		)
			throw new Error("Invalid restore journal; inspect it manually.");
		const backup = await loadCheckpoint(root, data.backup);
		if (backup.trigger !== "before-restore") throw new Error("Journal backup is not a recovery checkpoint.");
		return { backup, target: data.target, paths: data.paths, fingerprint: hash(raw) };
	} finally {
		await handle.close();
	}
}

export async function restoreCheckpoint(
	root: string,
	plan: RestorePlan,
	options: CaptureOptions,
): Promise<StoredCheckpoint> {
	return lock(root, async () => {
		options.signal?.throwIfAborted();
		const pending = await readRestoreRecovery(root);
		if (
			pending
				? pending.fingerprint !== options.recovery ||
					plan.target.ref !== pending.backup.ref ||
					JSON.stringify([...plan.paths].sort()) !== JSON.stringify([...pending.paths].sort())
				: options.recovery !== undefined
		)
			throw new Error(
				"An incomplete restore needs an explicit /midnight checkpoints recover preview; no files changed.",
			);
		const checked = await prepareRestore(root, plan.target, plan.paths);
		if (checked.fingerprint !== plan.fingerprint || JSON.stringify(checked.changes) !== JSON.stringify(plan.changes))
			throw new Error("Files or index changed after the preview; review a new restore plan.");
		const backup = await captureUnlocked(root, { ...options, trigger: "before-restore", scope: plan.paths });
		if (plan.paths.some((path) => backup.excluded.some((e) => e.path === path)))
			throw new Error("Backup coverage is incomplete; no files were restored.");
		const final = await prepareRestore(root, plan.target, plan.paths);
		if (final.fingerprint !== plan.fingerprint)
			throw new Error("Files changed while making the backup; restore cancelled.");
		const journal = await gitPath(root, "midnight-restore.json");
		const journalDraft = pending ? `${journal}.draft-${randomUUID()}` : journal;
		const journalHandle = await open(journalDraft, "wx", 0o600);
		try {
			await journalHandle.writeFile(
				JSON.stringify({
					version: 1,
					target: plan.target.ref,
					backup: backup.ref,
					paths: plan.paths,
					started: Date.now(),
				}),
			);
			await journalHandle.sync();
		} finally {
			await journalHandle.close();
		}
		if (pending) {
			try {
				await rename(journalDraft, journal);
			} finally {
				await rm(journalDraft, { force: true });
			}
		}
		const index = await gitPath(root, "index");
		const indexLock = `${index}.lock`;
		let ownedIndexLock = false;
		try {
			const handle = await open(indexLock, "wx", 0o600);
			ownedIndexLock = true;
			await handle.close();
			try {
				await copyFile(index, indexLock);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				const empty = await temporaryIndex(root);
				try {
					await git(root, ["read-tree", "--empty"], { env: empty.env, signal: options.signal });
					await copyFile(String(empty.env.GIT_INDEX_FILE), indexLock);
				} finally {
					await rm(empty.dir, { recursive: true, force: true });
				}
			}
			const env = { GIT_INDEX_FILE: indexLock };
			const wt = await tree(root, plan.target.worktreeTree);
			const idx = await tree(root, plan.target.indexTree);
			const records = plan.changes
				.filter((change) => change.index)
				.map((change) => indexRecord(change.path, idx.get(change.path), "0".repeat(plan.target.indexTree.length)));
			if (records.length)
				await git(root, ["update-index", "-z", "--index-info"], {
					env,
					input: records.join(""),
					signal: options.signal,
				});
			const baseline = new Map<string, string>();
			for (const path of plan.paths) {
				const file = await inspectFile(root, path);
				baseline.set(path, JSON.stringify([file ? hash(file.data) : null, file?.mode]));
			}
			const late = await prepareRestore(root, plan.target, plan.paths);
			if (late.fingerprint !== plan.fingerprint) throw new Error("Files changed before restore writes began.");
			for (const change of plan.changes.filter((change) => change.worktree)) {
				options.signal?.throwIfAborted();
				const target = await filePath(root, change.path);
				const now = await head(root, options.signal);
				if (now.head !== plan.target.head || now.branch !== plan.target.branch)
					throw new Error("HEAD changed during restoration.");
				const present = await inspectFile(root, change.path);
				if (JSON.stringify([present ? hash(present.data) : null, present?.mode]) !== baseline.get(change.path))
					throw new Error("A file changed during restoration; recovery is required.");
				const desired = wt.get(change.path);
				if (!desired) {
					await unlink(target).catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error;
					});
					continue;
				}
				await mkdir(dirname(target), { recursive: true });
				await filePath(root, change.path);
				const temporary = `${target}.midnight-${randomUUID()}`;
				try {
					const file = await open(temporary, "wx", desired.mode === "100755" ? 0o755 : 0o644);
					try {
						await file.writeFile(await git(root, ["cat-file", "blob", desired.sha], { signal: options.signal }));
					} finally {
						await file.close();
					}
					await filePath(root, change.path);
					const last = await inspectFile(root, change.path);
					if (JSON.stringify([last ? hash(last.data) : null, last?.mode]) !== baseline.get(change.path))
						throw new Error("A file changed before replacement; recovery is required.");
					await rename(temporary, target);
					if (process.platform !== "win32") await chmod(target, desired.mode === "100755" ? 0o755 : 0o644);
				} finally {
					await rm(temporary, { force: true });
				}
			}
			const now = await head(root);
			if (now.head !== plan.target.head || now.branch !== plan.target.branch)
				throw new Error("HEAD changed during restoration.");
			if (records.length) {
				await rename(indexLock, index);
				ownedIndexLock = false;
			}
			await unlink(journal);
			return backup;
		} catch (error) {
			throw new Error(
				`Restore did not complete. Recovery checkpoint: ${backup.ref}; journal: ${journal}. ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (ownedIndexLock) await rm(indexLock, { force: true });
		}
	});
}
export async function changedPaths(root: string, before: StoredCheckpoint, after: StoredCheckpoint): Promise<string[]> {
	return [
		...new Set([
			...nul(
				await git(root, [
					"diff-tree",
					"--no-commit-id",
					"--name-only",
					"-r",
					"-z",
					before.worktreeTree,
					after.worktreeTree,
				]),
			),
			...nul(
				await git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", before.indexTree, after.indexTree]),
			),
		]),
	].filter((path) => !exclusion(path));
}
