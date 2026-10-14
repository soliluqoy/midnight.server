import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	captureCheckpoint,
	git,
	listCheckpoints,
	loadCheckpoint,
	prepareRestore,
	pruneCheckpoints,
	readRestoreRecovery,
	restoreCheckpoint,
	safePath,
} from "../src/checkpoints/core.ts";

import { importLegacyCheckpoint, readLegacyCheckpoint } from "../src/checkpoints/legacy.ts";

async function fixture(t: test.TestContext, commit = true) {
	const root = await mkdtemp(join(tmpdir(), "midnight-checkpoint-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await git(root, ["init", "-q", "--initial-branch=main"]);
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
