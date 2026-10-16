import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import fsPromises, { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	captureCheckpoint,
	git,
	listCheckpoints,
	loadCheckpoint,
	loadCheckpoints,
	MAX_CAPTURE_BYTES,
	MAX_FILE_BYTES,
	MAX_PATHS,
	prepareRestore,
	pruneCheckpoints,
	readRestoreRecovery,
	restoreCheckpoint,
	safePath,
	storeImportedCheckpoint,
} from "../src/checkpoints/core.ts";
import { registerCheckpoints } from "../src/checkpoints/index.ts";

import { importLegacyCheckpoint, readLegacyCheckpoint } from "../src/checkpoints/legacy.ts";

async function fixture(t: test.TestContext, commit = true, objectFormat = "sha1") {
	const root = await mkdtemp(join(tmpdir(), "midnight checkpoint λ-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await git(root, ["init", "-q", "--initial-branch=main", `--object-format=${objectFormat}`]);
	await git(root, ["config", "user.name", "Test"]);
	await git(root, ["config", "user.email", "test@local.invalid"]);
	await git(root, ["config", "core.autocrlf", "false"]);
	if (commit) {
		await writeFile(join(root, "file.txt"), "base\n");
		await writeFile(join(root, "keep.txt"), "keep\n");
		await git(root, ["add", "--", "file.txt", "keep.txt"]);
		await git(root, ["commit", "-qm", "base"]);
	}
	return root;
}
const options = { sessionId: "test-session", trigger: "manual" as const };
const out = async (root: string, args: string[]) => (await git(root, args)).toString("utf8");

async function traceGit<T>(root: string, operation: () => Promise<T>) {
	const path = join(root, ".git", "checkpoint-trace.json");
	await writeFile(path, "");
	const previous = process.env.GIT_TRACE2_EVENT;
	process.env.GIT_TRACE2_EVENT = path;
	let value: T;
	try {
		value = await operation();
	} finally {
		if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
		else process.env.GIT_TRACE2_EVENT = previous;
	}
	const commands = (await readFile(path, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { event: string; argv?: string[] })
		.filter((event) => event.event === "start")
		.map((event) => event.argv ?? []);
	return { value, commands };
}

function interceptBlobWrites(t: test.TestContext, inspect: (proc: ChildProcess) => void) {
	const spawn = childProcess.spawn;
	t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
		const proc = spawn(...args);
		if (Array.isArray(args[1]) && args[1].includes("--stdin-paths")) inspect(proc);
		return proc;
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
}

async function captureTempRoot(t: test.TestContext) {
	const path = await mkdtemp(join(tmpdir(), "midnight spool λ space-"));
	const unusual = join(path, process.platform === "win32" ? "日本語 space" : '日本語 "quote" \\ slash\nline');
	await mkdir(unusual);
	const previous = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
	for (const key of Object.keys(previous)) process.env[key] = unusual;
	t.after(async () => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(path, { recursive: true, force: true });
	});
	return unusual;
}

test("capture batches verified raw blobs once, cleans unusual spool paths and reuses unchanged objects", async (t) => {
	const root = await fixture(t);
	const temporary = await captureTempRoot(t);
	const files = new Map([
		["space 'quote' λ.txt", Buffer.from([0, 255, 128, 13, 10, 1])],
		["-option.txt", Buffer.from("raw\r\nbytes\r\n")],
		[process.platform === "win32" ? "日本語.txt" : '日本語 "quote"\nline.txt', Buffer.from("third\n")],
	]);
	for (const [path, data] of files) await writeFile(join(root, path), data);
	const index = await readFile(join(root, ".git", "index"));
	interceptBlobWrites(t, () => {
		const [directory] = readdirSync(temporary);
		const spools = readdirSync(join(temporary, directory)).filter((path) => path.startsWith("blob-"));
		assert.equal(spools.length, files.size);
		for (const path of spools) {
			if (process.platform !== "win32") assert.equal(statSync(join(temporary, directory, path)).mode & 0o777, 0o600);
		}
		for (const path of files.keys()) writeFileSync(join(root, path), "mutable worktree changed after inspection");
	});
	const { value: first, commands } = await traceGit(root, () => captureCheckpoint(root, options));
	assert.deepEqual(
		commands.filter((args) => args.includes("hash-object")),
		[["git", "--no-optional-locks", "hash-object", "-w", "--no-filters", "--stdin-paths"]],
	);
	for (const [path, data] of files) {
		assert.deepEqual(await git(root, ["show", `${first.worktreeTree}:${path}`]), data);
		await writeFile(join(root, path), data);
	}
	assert.deepEqual(await readdir(temporary), []);
	assert.deepEqual(await readFile(join(root, ".git", "index")), index);
	const { value: reused, commands: reuseCommands } = await traceGit(root, () =>
		captureCheckpoint(root, { ...options, previous: first, deduplicate: true }),
	);
	assert.equal(reused.ref, first.ref);
	assert.equal(
		reuseCommands.some((args) => args.includes("hash-object")),
		false,
	);
	assert.deepEqual(await readdir(temporary), []);
});

test("blob batches verify repository-specific SHA-256 object IDs", async (t) => {
	const root = await fixture(t, true, "sha256");
	const data = Buffer.from([0, 128, 255, 13, 10]);
	await writeFile(join(root, "file.txt"), data);
	const { value: cp, commands } = await traceGit(root, () => captureCheckpoint(root, options));
	assert.equal(cp.worktreeTree.length, 64);
	assert.equal(commands.filter((args) => args.includes("--stdin-paths")).length, 1);
	assert.deepEqual(await git(root, ["show", `${cp.worktreeTree}:file.txt`]), data);
});

test("capture rejects malformed, missing, extra, wrong-width or reordered blob output before index mutation", async (t) => {
	const root = await fixture(t);
	const temporary = await captureTempRoot(t);
	await writeFile(join(root, "file.txt"), "changed\n");
	await writeFile(join(root, "keep.txt"), "different\n");
	const index = await readFile(join(root, ".git", "index"));
	let corrupt = (chunk: Buffer) => chunk;
	interceptBlobWrites(t, (proc) => {
		assert.ok(proc.stdout);
		const emit = proc.stdout.emit.bind(proc.stdout);
		const chunks: Buffer[] = [];
		t.mock.method(proc.stdout, "emit", (event: string, ...args: unknown[]) => {
			if (event === "data") {
				chunks.push(args[0] as Buffer);
				return true;
			}
			if (event === "end") emit("data", corrupt(Buffer.concat(chunks)));
			return emit(event, ...args);
		});
	});
	for (const change of [
		() => Buffer.from("not-an-oid\n"),
		() => Buffer.alloc(0),
		(chunk: Buffer) => Buffer.concat([chunk, Buffer.from(`${"0".repeat(40)}\n`)]),
		() => Buffer.from(`${"0".repeat(64)}\n${"0".repeat(64)}\n`),
		() => Buffer.from(`${"0".repeat(40)}\n${"0".repeat(40)}\n`),
		(chunk: Buffer) => Buffer.from(`${chunk.toString("utf8").trim().split("\n").reverse().join("\n")}\n`),
	]) {
		corrupt = change;
		const { commands } = await traceGit(root, () =>
			assert.rejects(captureCheckpoint(root, options), /blob batch output/),
		);
		assert.equal(
			commands.some((args) => args.includes("update-index") || args.includes("update-ref")),
			false,
		);
		assert.deepEqual(await readdir(temporary), []);
		assert.deepEqual(await readFile(join(root, ".git", "index")), index);
		assert.equal((await listCheckpoints(root, options.sessionId)).length, 0);
		await assert.rejects(stat(join(root, ".git", "midnight-checkpoints.lock")), { code: "ENOENT" });
	}
});

test("cancellation during blob writing rejects capture and removes its spool and lock", async (t) => {
	const root = await fixture(t);
	const temporary = await captureTempRoot(t);
	await writeFile(join(root, "file.txt"), "changed\n");
	const abort = new AbortController();
	interceptBlobWrites(t, (proc) => proc.once("spawn", () => abort.abort()));
	const { commands } = await traceGit(root, () =>
		assert.rejects(captureCheckpoint(root, { ...options, signal: abort.signal }), { name: "AbortError" }),
	);
	assert.equal(
		commands.some((args) => args.includes("update-index") || args.includes("update-ref")),
		false,
	);
	assert.deepEqual(await readdir(temporary), []);
	await assert.rejects(stat(join(root, ".git", "midnight-checkpoints.lock")), { code: "ENOENT" });
	assert.equal((await listCheckpoints(root, options.sessionId)).length, 0);
});

test("spool write failure rejects capture without publishing and cleans partial files", async (t) => {
	const root = await fixture(t);
	const temporary = await captureTempRoot(t);
	await writeFile(join(root, "file.txt"), "changed\n");
	const originalOpen = fsPromises.open;
	t.mock.method(fsPromises, "open", async (...args: Parameters<typeof originalOpen>) => {
		const handle = await originalOpen(...args);
		if (String(args[0]).endsWith("blob-0"))
			t.mock.method(handle, "writeFile", async () => {
				throw new Error("injected spool write failure");
			});
		return handle;
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	await assert.rejects(captureCheckpoint(root, options), /injected spool write failure/);
	assert.deepEqual(await readdir(temporary), []);
	assert.equal((await listCheckpoints(root, options.sessionId)).length, 0);
	await assert.rejects(stat(join(root, ".git", "midnight-checkpoints.lock")), { code: "ENOENT" });
});

test("spool bytes stay within the cumulative read budget, including inspected over-budget files", async (t) => {
	const root = await fixture(t, false);
	const temporary = await captureTempRoot(t);
	const data = Buffer.alloc(MAX_FILE_BYTES, 1);
	for (let index = 0; index < 7; index++) await writeFile(join(root, `large-${index}`), data);
	await writeFile(join(root, "z-small"), "also excluded after over-budget inspection");
	interceptBlobWrites(t, () => {
		const [directory] = readdirSync(temporary);
		const spools = readdirSync(join(temporary, directory)).filter((path) => path.startsWith("blob-"));
		assert.equal(spools.length, 6);
		const bytes = spools.reduce((sum, path) => sum + statSync(join(temporary, directory, path)).size, 0);
		assert.equal(bytes, 6 * MAX_FILE_BYTES);
		assert.ok(bytes <= MAX_CAPTURE_BYTES);
	});
	const cp = await captureCheckpoint(root, options);
	assert.equal(cp.covered.length, 6);
	assert.deepEqual(cp.excluded, [
		{ path: "large-6", reason: "snapshot exceeds 64 MiB read budget" },
		{ path: "z-small", reason: "snapshot exceeds 64 MiB read budget" },
	]);
	assert.ok(6 * MAX_FILE_BYTES <= MAX_CAPTURE_BYTES);
	assert.deepEqual(await readdir(temporary), []);
	await assert.rejects(
		captureCheckpoint(root, {
			...options,
			scope: Array.from({ length: MAX_PATHS + 1 }, (_, index) => `missing-${index}`),
		}),
		/candidate paths/,
	);
	assert.deepEqual(await readdir(temporary), []);
});

test("history loads in bounded batches, preserving metadata without a cross-call cache", async (t) => {
	const root = await fixture(t);
	const first = await captureCheckpoint(root, options);
	const snapshots = [first];
	for (let i = 1; i < 10; i++)
		snapshots.push(await storeImportedCheckpoint(root, { ...first, id: randomUUID(), timestamp: first.timestamp + i }));
	const { value, commands } = await traceGit(root, () => listCheckpoints(root, options.sessionId));
	assert.deepEqual(value, snapshots);
	assert.equal(commands.length, 5, "one ref listing plus two processes per eight-checkpoint batch");
	assert.equal(commands.filter((argv) => argv.includes("cat-file")).length, 4);
	const missing = first.ref.replace(first.id, randomUUID());
	const partial = await loadCheckpoints(root, [first.ref, missing, "HEAD", first.ref]);
	assert.deepEqual(partial.get(first.ref), first);
	assert.ok(partial.get(missing) instanceof Error);
	assert.ok(partial.get("HEAD") instanceof Error);
	assert.equal(partial.size, 3);
	await git(root, ["update-ref", "-d", first.ref, first.commit]);
	await assert.rejects(loadCheckpoint(root, first.ref), /unavailable|pruned/);
	await assert.rejects(prepareRestore(root, first, ["file.txt"]), /unavailable|pruned/);
	const abort = new AbortController();
	abort.abort();
	await assert.rejects(loadCheckpoints(root, [snapshots[1].ref], abort.signal), { name: "AbortError" });
});

test("batch validation rejects corrupt metadata, non-commits and mismatched tree reachability independently", async (t) => {
	const root = await fixture(t);
	const cp = await captureCheckpoint(root, options);
	const parent = (await out(root, ["rev-parse", `${cp.commit}^1`])).trim();
	const blob = (await out(root, ["rev-parse", "HEAD:file.txt"])).trim();
	const bad: string[] = [];
	for (const change of [
		{ sessionId: "wrong-session" },
		{ worktreeTree: blob },
		{ indexTree: blob },
		{ padding: "x".repeat(1024 * 1024) },
	]) {
		const id = randomUUID();
		const ref = cp.ref.replace(cp.id, id);
		const commit = (
			await git(root, ["commit-tree", cp.worktreeTree, "-p", parent], {
				input: JSON.stringify({ ...cp, id, ...change }),
			})
		)
			.toString("utf8")
			.trim();
		await git(root, ["update-ref", ref, commit]);
		bad.push(ref);
	}
	const nonCommit = cp.ref.replace(cp.id, randomUUID());
	await git(root, ["update-ref", nonCommit, blob]);
	bad.push(nonCommit);
	await writeFile(join(root, "file.txt"), "different staged tree\n");
	await git(root, ["add", "--", "file.txt"]);
	const stagedTree = (await out(root, ["write-tree"])).trim();
	const id = randomUUID();
	const wrongParent = cp.ref.replace(cp.id, id);
	const forged = (
		await git(root, ["commit-tree", cp.worktreeTree, "-p", parent], {
			input: JSON.stringify({ ...cp, id, indexTree: stagedTree }),
		})
	)
		.toString("utf8")
		.trim();
	await git(root, ["update-ref", wrongParent, forged]);
	bad.push(wrongParent);
	const loaded = await loadCheckpoints(root, [cp.ref, ...bad]);
	assert.deepEqual(loaded.get(cp.ref), cp);
	for (const ref of bad) assert.ok(loaded.get(ref) instanceof Error, ref);
	await assert.rejects(listCheckpoints(root, options.sessionId));
});

test("unchanged captures deduplicate before commit/ref writes but retain coverage changes and fresh recovery backups", async (t) => {
	const root = await fixture(t);
	const first = await captureCheckpoint(root, options);
	const { value, commands } = await traceGit(root, () =>
		captureCheckpoint(root, { ...options, previous: first, deduplicate: true }),
	);
	assert.deepEqual(value, first);
	assert.equal(
		commands.some((argv) => argv.includes("commit-tree") || argv.includes("update-ref")),
		false,
	);
	assert.equal(
		commands.some(
			(argv) => argv.includes("diff-tree") || argv.includes("update-index") || argv.includes("hash-object"),
		),
		false,
	);
	await writeFile(join(root, ".env"), "TEST=fixture-not-a-secret\n");
	const excluded = await captureCheckpoint(root, { ...options, previous: first, deduplicate: true });
	assert.notEqual(excluded.ref, first.ref);
	assert.equal(excluded.worktreeTree, first.worktreeTree);
	assert.ok(excluded.excluded.some((entry) => entry.path === ".env"));
	const scoped = await captureCheckpoint(root, {
		...options,
		previous: excluded,
		deduplicate: true,
		scope: ["absent.txt"],
	});
	assert.notEqual(scoped.ref, excluded.ref);
	assert.ok(scoped.covered.includes("absent.txt"));
	assert.ok(scoped.scope.includes("absent.txt"));
	const backup = await captureCheckpoint(root, {
		...options,
		trigger: "before-restore",
		previous: scoped,
		deduplicate: true,
		scope: scoped.scope,
	});
	assert.notEqual(backup.ref, scoped.ref);
	const ordinary = await captureCheckpoint(root, {
		...options,
		previous: backup,
		deduplicate: true,
		scope: backup.scope,
	});
	assert.notEqual(ordinary.ref, backup.ref);
	await git(root, ["update-ref", "-d", ordinary.ref, ordinary.commit]);
	const replacement = await captureCheckpoint(root, {
		...options,
		previous: ordinary,
		deduplicate: true,
		scope: ordinary.scope,
	});
	assert.notEqual(replacement.ref, ordinary.ref);
	assert.deepEqual(await loadCheckpoint(root, replacement.ref), replacement);
	await writeFile(join(root, "file.txt"), "changed raw working bytes\n");
	const changed = await captureCheckpoint(root, {
		...options,
		previous: replacement,
		deduplicate: true,
		scope: replacement.scope,
	});
	assert.notEqual(changed.worktreeTree, replacement.worktreeTree);
	await git(root, ["add", "--", "file.txt"]);
	const staged = await captureCheckpoint(root, {
		...options,
		previous: changed,
		deduplicate: true,
		scope: changed.scope,
	});
	assert.equal(staged.worktreeTree, changed.worktreeTree);
	assert.notEqual(staged.indexTree, changed.indexTree);
	const otherSession = await captureCheckpoint(root, {
		...options,
		sessionId: "other-session",
		previous: staged,
		deduplicate: true,
		scope: staged.scope,
	});
	assert.notEqual(otherSession.ref, staged.ref);
	assert.equal(otherSession.sessionId, "other-session");
});

test("controller resumes branch/redo snapshots in batches and reuses unchanged captures; cancellation drops stale startup", async (t) => {
	const root = await fixture(t);
	const cp = await captureCheckpoint(root, options);
	const entries = [
		{ type: "custom", customType: "midnight-checkpoint", data: { version: 1, ref: cp.ref } },
		{
			type: "custom",
			customType: "midnight-checkpoint-redo",
			data: { version: 1, steps: [{ ref: cp.ref, paths: ["file.txt"] }] },
		},
	];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const records: unknown[] = [];
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		registerCommand: () => {},
		appendEntry: (...args: unknown[]) => records.push(args),
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: root,
		sessionManager: {
			getBranch: () => entries,
			getEntries: () => entries,
			getSessionId: () => options.sessionId,
			getLeafId: () => null,
		},
	} as unknown as ExtensionContext;
	const controller = registerCheckpoints(
		pi,
		() => true,
		() => {},
	);
	await handlers.get("session_start")?.({}, ctx);
	assert.match(controller.status(), /Checkpoints: 1 .* 1 redo steps/);
	assert.equal(records.length, 0, "unchanged resume must not record a replacement snapshot");
	await handlers.get("tool_result")?.({ toolName: "bash", input: {}, isError: false }, ctx);
	await handlers.get("turn_end")?.({}, ctx);
	assert.equal(records.length, 0, "read-only shell still verifies files but does not write another snapshot");
	const startup = handlers.get("session_start")?.({}, ctx);
	controller.cancel();
	await startup;
	assert.match(controller.status(), /Checkpoints: unavailable/);
	assert.equal(records.length, 0);
});

test("capture does not mutate HEAD or the real index and preserves staged versus unstaged layers", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "file.txt"), "staged\n");
	await git(root, ["add", "--", "file.txt"]);
	await writeFile(join(root, "file.txt"), "unstaged\n");
	const index = await readFile(join(root, ".git", "index"));
	const head = await out(root, ["rev-parse", "HEAD"]);
	const cp = await captureCheckpoint(root, options);
	assert.deepEqual(await readFile(join(root, ".git", "index")), index);
	assert.equal(await out(root, ["rev-parse", "HEAD"]), head);
	assert.notEqual(cp.indexTree, cp.worktreeTree);
	assert.deepEqual(await loadCheckpoint(root, cp.ref), cp);
});

test("scoped restore retains unrelated files and index entries, never moves HEAD, and has a redo backup", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "file.txt"), "staged\n");
	await git(root, ["add", "--", "file.txt"]);
	await writeFile(join(root, "file.txt"), "unstaged\n");
	const cp = await captureCheckpoint(root, options);
	await writeFile(join(root, "file.txt"), "new staged\n");
	await git(root, ["add", "--", "file.txt"]);
	await writeFile(join(root, "file.txt"), "new working\n");
	await writeFile(join(root, "keep.txt"), "external staged\n");
	await git(root, ["add", "--", "keep.txt"]);
	await writeFile(join(root, "unrelated.txt"), "leave me\n");
	await writeFile(join(root, "owned.txt"), "new session file\n");
	const scope = ["file.txt", "owned.txt"];
	const head = await out(root, ["rev-parse", "HEAD"]);
	const plan = await prepareRestore(root, cp, scope);
	assert.equal(plan.changes.find((row) => row.path === "owned.txt")?.deletion, true);
	const backup = await restoreCheckpoint(root, plan, options);
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "unstaged\n");
	assert.equal(await out(root, ["show", ":file.txt"]), "staged\n");
	assert.equal(await out(root, ["show", ":keep.txt"]), "external staged\n");
	assert.equal(await readFile(join(root, "unrelated.txt"), "utf8"), "leave me\n");
	await assert.rejects(readFile(join(root, "owned.txt")), { code: "ENOENT" });
	assert.equal(await out(root, ["rev-parse", "HEAD"]), head);
	await restoreCheckpoint(root, await prepareRestore(root, backup, scope), options);
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "new working\n");
	assert.equal(await out(root, ["show", ":file.txt"]), "new staged\n");
	assert.equal(await readFile(join(root, "owned.txt"), "utf8"), "new session file\n");
});

test("restore rejects changes after preview before modifying anything", async (t) => {
	const root = await fixture(t);
	const cp = await captureCheckpoint(root, options);
	await writeFile(join(root, "file.txt"), "change\n");
	const plan = await prepareRestore(root, cp, ["file.txt"]);
	await writeFile(join(root, "file.txt"), "external change\n");
	await assert.rejects(restoreCheckpoint(root, plan, options), /after the preview/);
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "external change\n");
});

test("changed HEAD or branch is refused instead of resetting Git history", async (t) => {
	const root = await fixture(t);
	const cp = await captureCheckpoint(root, options);
	await writeFile(join(root, "file.txt"), "commit\n");
	await git(root, ["add", "--", "file.txt"]);
	await git(root, ["commit", "-qm", "next"]);
	await assert.rejects(prepareRestore(root, cp, ["file.txt"]), /HEAD changed/);
	await git(root, ["checkout", "-q", "-b", "other", cp.head ?? "HEAD"]);
	await assert.rejects(prepareRestore(root, cp, ["file.txt"]), /Branch or HEAD/);
});

test("paths use NUL records and literal arguments, preserving spaces, Unicode, and leading dashes", async (t) => {
	const root = await fixture(t);
	const paths = [
		"space 'quote'.txt",
		"日本語.txt",
		"-option.txt",
		...(process.platform === "win32" ? [] : ["line\nbreak.txt"]),
	];
	for (const path of paths) await writeFile(join(root, path), path);
	const cp = await captureCheckpoint(root, options);
	for (const path of paths) await writeFile(join(root, path), "changed");
	await restoreCheckpoint(root, await prepareRestore(root, cp, paths), options);
	for (const path of paths) assert.equal(await readFile(join(root, path), "utf8"), path);
});

test("sensitive paths are excluded, reported, and cannot be restored", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, ".env"), "TEST=fixture-not-a-secret\n");
	const cp = await captureCheckpoint(root, options);
	assert.equal(cp.excluded.find((item) => item.path === ".env")?.reason, "sensitive path");
	await assert.rejects(prepareRestore(root, cp, [".env"]), /Unsafe restore scope/);
	for (const path of ["../outside", "/outside", "C:/outside", ".git/config", "dir/../outside", "dir\\outside", "x\0y"])
		assert.equal(safePath(path), false);
});

test("worktree and index locks prevent competing checkpoint or restore operations", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, ".git", "midnight-checkpoints.lock"), "fixture");
	await assert.rejects(captureCheckpoint(root, options), /Another checkpoint/);
	await rm(join(root, ".git", "midnight-checkpoints.lock"));
	const cp = await captureCheckpoint(root, options);
	await writeFile(join(root, "file.txt"), "new\n");
	const plan = await prepareRestore(root, cp, ["file.txt"]);
	await writeFile(join(root, ".git", "index.lock"), "other Git operation");
	await assert.rejects(restoreCheckpoint(root, plan, options), /Recovery checkpoint/);
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "new\n");
	assert.equal(await readFile(join(root, ".git", "index.lock"), "utf8"), "other Git operation");
});

test("retention only prunes the current session, preserving other sessions and recovery snapshots", async (t) => {
	const root = await fixture(t);
	const other = await captureCheckpoint(root, { ...options, sessionId: "other" });
	const first = await captureCheckpoint(root, options);
	await captureCheckpoint(root, options);
	const recovery = await captureCheckpoint(root, { ...options, trigger: "before-restore" });
	await pruneCheckpoints(root, options.sessionId, 1);
	await assert.rejects(loadCheckpoint(root, first.ref));
	assert.equal((await loadCheckpoint(root, other.ref)).id, other.id);
	assert.equal((await loadCheckpoint(root, recovery.ref)).id, recovery.id);
	assert.equal((await listCheckpoints(root, options.sessionId)).length, 2);
});

test("unborn repositories can capture without creating HEAD or changing the real index", async (t) => {
	const root = await fixture(t, false);
	await writeFile(join(root, "new.txt"), "unborn\n");
	const cp = await captureCheckpoint(root, options);
	assert.equal(cp.head, null);
	await assert.rejects(out(root, ["rev-parse", "--verify", "HEAD"]));
	await assert.rejects(readFile(join(root, ".git", "index")), { code: "ENOENT" });
});

test("conflicted indexes and aborted captures are unavailable, not clean snapshots", async (t) => {
	const root = await fixture(t);
	const abort = new AbortController();
	abort.abort();
	await assert.rejects(captureCheckpoint(root, { ...options, signal: abort.signal }), { name: "AbortError" });
	assert.equal((await listCheckpoints(root, options.sessionId)).length, 0);
});

test("raw snapshots preserve CRLF even when Git considers the working file clean", async (t) => {
	const root = await fixture(t);
	await git(root, ["config", "core.autocrlf", "true"]);
	await writeFile(join(root, "file.txt"), "base\r\n");
	const cp = await captureCheckpoint(root, options);
	await writeFile(join(root, "file.txt"), "changed\n");
	await restoreCheckpoint(root, await prepareRestore(root, cp, ["file.txt"]), options);
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "base\r\n");
});

test("index snapshots remain reachable after immediate Git garbage collection", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "file.txt"), "unique staged\n");
	await git(root, ["add", "--", "file.txt"]);
	await writeFile(join(root, "file.txt"), "different working\n");
	const cp = await captureCheckpoint(root, options);
	await git(root, ["reset", "-q", "HEAD", "--", "file.txt"]);
	await git(root, ["gc", "--prune=now"]);
	await restoreCheckpoint(root, await prepareRestore(root, cp, ["file.txt"]), options);
	assert.equal(await out(root, ["show", ":file.txt"]), "unique staged\n");
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "different working\n");
});

test("observed missing paths are covered and unborn restores retain unrelated staged files", async (t) => {
	const root = await fixture(t, false);
	await writeFile(join(root, "owned.txt"), "original\n");
	const cp = await captureCheckpoint(root, { ...options, scope: ["owned.txt"] });
	await rm(join(root, "owned.txt"));
	const missing = await captureCheckpoint(root, { ...options, previous: cp, scope: ["owned.txt"] });
	assert.ok(missing.covered.includes("owned.txt"));
	assert.deepEqual(await loadCheckpoint(root, missing.ref), missing);
	await writeFile(join(root, "keep.txt"), "external staged\n");
	await git(root, ["add", "--", "keep.txt"]);
	await restoreCheckpoint(root, await prepareRestore(root, cp, ["owned.txt"]), options);
	assert.equal(await readFile(join(root, "owned.txt"), "utf8"), "original\n");
	assert.equal(await out(root, ["show", ":keep.txt"]), "external staged\n");
	await assert.rejects(out(root, ["rev-parse", "--verify", "HEAD"]));
});

test("failure journals block ordinary restores and require exact explicit recovery", async (t) => {
	const root = await fixture(t);
	const target = await captureCheckpoint(root, options);
	await writeFile(join(root, "file.txt"), "recovery state\n");
	const backup = await captureCheckpoint(root, { ...options, trigger: "before-restore", scope: ["file.txt"] });
	await writeFile(join(root, "file.txt"), "partial restore\n");
	await writeFile(
		join(root, ".git", "midnight-restore.json"),
		JSON.stringify({ version: 1, target: target.ref, backup: backup.ref, paths: ["file.txt"] }),
	);
	const recovery = await readRestoreRecovery(root);
	assert.ok(recovery);
	const plan = await prepareRestore(root, backup, recovery.paths);
	await assert.rejects(restoreCheckpoint(root, plan, options), /explicit/);
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "partial restore\n");
	await restoreCheckpoint(root, plan, { ...options, recovery: recovery.fingerprint });
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "recovery state\n");
	assert.equal(await readRestoreRecovery(root), null);
});

test("actual merge conflicts are unavailable, not valid clean snapshots", async (t) => {
	const root = await fixture(t);
	await git(root, ["checkout", "-qb", "other"]);
	await writeFile(join(root, "file.txt"), "other\n");
	await git(root, ["add", "."]);
	await git(root, ["commit", "-qm", "other"]);
	await git(root, ["checkout", "-q", "main"]);
	await writeFile(join(root, "file.txt"), "main\n");
	await git(root, ["add", "."]);
	await git(root, ["commit", "-qm", "main"]);
	await assert.rejects(git(root, ["merge", "other"]));
	await assert.rejects(captureCheckpoint(root, options), /conflict|unmerged/i);
	assert.equal((await listCheckpoints(root, options.sessionId)).length, 0);
});

test("legacy metadata import retains original refs and does not restore files", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "file.txt"), "legacy working\n");
	const original = await captureCheckpoint(root, options);
	const ref = "refs/pi-checkpoints/legacy-fixture";
	const metadata = `sessionId ${options.sessionId}\nindex-tree ${original.indexTree}\nworktree-tree ${original.worktreeTree}\nhead ${original.head}\nbranch main\ncreated ${new Date(original.timestamp).toISOString()}\nlargeFiles ["large.txt"]\nlargeDirs ["skipped"]`;
	const commit = (
		await out(root, ["commit-tree", original.worktreeTree, "-p", original.head ?? "HEAD", "-m", metadata])
	).trim();
	await git(root, ["update-ref", ref, commit]);
	const legacy = await readLegacyCheckpoint(root, ref);
	assert.equal(legacy.snapshot.entryId, null);
	assert.ok(legacy.snapshot.excluded.some((entry) => entry.path === "large.txt"));
	await writeFile(join(root, "file.txt"), "current\n");
	const imported = await importLegacyCheckpoint(root, ref, options.sessionId);
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "current\n");
	assert.equal((await out(root, ["rev-parse", ref])).trim(), commit);
	assert.deepEqual(await loadCheckpoint(root, imported.ref), imported);
	await assert.rejects(prepareRestore(root, imported, ["skipped/child.txt"]), /uncaptured/);
	await assert.rejects(importLegacyCheckpoint(root, ref, "another-session"), /another session/);
});

test("symlink replacement is refused before restore", async (t) => {
	const root = await fixture(t);
	const cp = await captureCheckpoint(root, options);
	await rm(join(root, "file.txt"));
	try {
		await symlink(join(root, "keep.txt"), join(root, "file.txt"));
	} catch {
		t.skip("Symlink creation unavailable on this host.");
		return;
	}
	await assert.rejects(prepareRestore(root, cp, ["file.txt"]), /symlink/);
	assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "keep\n");
});
