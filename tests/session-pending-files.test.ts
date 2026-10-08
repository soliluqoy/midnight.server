import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ExplorerLocation } from "../src/explorer-location.ts";
import { parseGitSnapshot, readGitSnapshot } from "../src/git-status.ts";
import { collectSessionFileChanges, type SessionFileChange } from "../src/session-file-changes.ts";
import { absoluteCandidate, parseNumstat, SessionPendingFiles } from "../src/session-pending-files.ts";
import { currentText, pendingGit } from "../src/session-pending-io.ts";

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}
async function fixture(t: { after(fn: () => Promise<void>): void }, repository = true) {
	const root = await mkdtemp(path.join(tmpdir(), "midnight-pending-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	if (repository) {
		git(root, "init", "-q");
		git(root, "config", "user.name", "Midnight Test");
		git(root, "config", "user.email", "test@example.invalid");
		git(root, "config", "core.autocrlf", "false");
	}
	return root;
}
function candidates(...paths: string[]): SessionFileChange[] {
	return paths.map((path) => ({
		path,
		added: 999,
		removed: 999,
		edits: [{ tool: "write", content: "old historical content" }],
	}));
}
async function base(root: string) {
	await writeFile(path.join(root, "file.txt"), "original\n");
	git(root, "add", ".");
	git(root, "commit", "-qm", "base");
}
async function refresh(reader: SessionPendingFiles, root: string, files = candidates("file.txt"), prefix = "") {
	const snapshot = await reader.reconcile(files, await readGitSnapshot(root, prefix));
	assert.ok(snapshot);
	return snapshot;
}

test("restore, delete, commit and subsequent edits reconcile without changing provenance", async (t) => {
	const root = await fixture(t);
	await base(root);
	const reader = new SessionPendingFiles(root);
	t.after(async () => reader.dispose());
	const history = candidates("file.txt", "new.txt");
	const originalHistory = structuredClone(history);
	await writeFile(path.join(root, "file.txt"), "edited\nsecond\n");
	await writeFile(path.join(root, "new.txt"), "current\n");
	let snapshot = await refresh(reader, root, history);
	assert.deepEqual([...snapshot.changedPaths], ["file.txt", "new.txt"]);
	assert.equal(snapshot.rows[0].added, 2);
	assert.equal(snapshot.rows[0].removed, 1);
	assert.match((await reader.preview(snapshot.rows[1]))[0].diff ?? "", /current/);
	git(root, "restore", "file.txt");
	await rm(path.join(root, "new.txt"));
	snapshot = await refresh(reader, root, history);
	assert.equal(snapshot.changedPaths.size, 0);
	assert.ok(snapshot.rows.every((row) => row.state === "clean"));
	assert.deepEqual(history, originalHistory);
	await rm(path.join(root, "file.txt"));
	snapshot = await refresh(reader, root, history);
	assert.equal(snapshot.rows[0].removed, 1);
	assert.match((await reader.preview(snapshot.rows[0]))[0].diff ?? "", /-1 original/);
	git(root, "add", "-A");
	git(root, "commit", "-qm", "delete");
	assert.equal((await refresh(reader, root, history)).changedPaths.size, 0);
	await writeFile(path.join(root, "file.txt"), "again\n");
	assert.equal((await refresh(reader, root, history)).rows[0].added, 1);
});

test("staged/unstaged layers, including compensating changes and stable M codes", async (t) => {
	const root = await fixture(t);
	await base(root);
	const reader = new SessionPendingFiles(root);
	await writeFile(path.join(root, "file.txt"), "staged\n");
	git(root, "add", ".");
	let row = (await refresh(reader, root)).rows[0];
	assert.equal(row.added, 1);
	assert.equal((await reader.preview(row)).length, 1);
	assert.match((await reader.preview(row))[0].title, /Staged/);
	await writeFile(path.join(root, "file.txt"), "original\n");
	row = (await refresh(reader, root)).rows[0];
	assert.equal(row.state, "pending");
	assert.equal(row.added, 2);
	assert.equal(row.removed, 2);
	let sections = await reader.preview(row);
	assert.equal(sections.length, 2);
	assert.match(sections[1].title, /Unstaged/);
	await writeFile(path.join(root, "file.txt"), "one\ntwo\nthree\n");
	row = (await refresh(reader, root)).rows[0];
	assert.equal(row.added, 4);
	sections = await reader.preview(row);
	assert.match(sections[1].diff ?? "", /three/);
	// If the file changes again, do not show a new diff with old line counts.
	await writeFile(path.join(root, "file.txt"), "changed again\n");
	assert.match((await reader.preview(row))[0].message ?? "", /Changed during preview/);
});

test("only touched paths, project subdirectory, external and nested repositories; shared scan", async (t) => {
	const root = await fixture(t);
	const external = await fixture(t);
	await base(root);
	await base(external);
	await mkdir(path.join(root, "sub"));
	await writeFile(path.join(root, "file.txt"), "user changes\n");
	await writeFile(path.join(root, "untouched.txt"), "not session touched\n");
	await writeFile(path.join(external, "file.txt"), "external\n");
	let externalScans = 0;
	const reader = new SessionPendingFiles(path.join(root, "sub"), {
		status: async (owner, signal) => {
			externalScans++;
			assert.equal(owner, external);
			const snapshot = await readGitSnapshot(owner, "", signal);
			assert.ok(snapshot);
			return snapshot;
		},
	});
	let snapshot = await refresh(
		reader,
		path.join(root, "sub"),
		candidates("../file.txt", path.join(external, "file.txt")),
		"sub/",
	);
	assert.equal(snapshot.changedPaths.size, 2);
	assert.equal(externalScans, 1);
	assert.ok(snapshot.rows.every((row) => row.state === "pending"));
	git(external, "restore", "file.txt");
	git(root, "restore", "file.txt");
	snapshot = await refresh(
		reader,
		path.join(root, "sub"),
		candidates("../file.txt", path.join(external, "file.txt")),
		"sub/",
	);
	assert.equal(snapshot.changedPaths.size, 0);
	const nested = path.join(root, "nested");
	await mkdir(nested);
	git(nested, "init", "-q");
	await writeFile(path.join(nested, "new.txt"), "nested\n");
	const nestedReader = new SessionPendingFiles(root);
	assert.equal((await refresh(nestedReader, root, candidates("nested/new.txt"))).rows[0].root, nested);
});

test("unborn HEAD, rename endpoints dedupe, literal Unicode/spaces paths", async (t) => {
	const root = await fixture(t);
	const file = "Unicode Ω [file] name.txt";
	await writeFile(path.join(root, file), "first\n");
	git(root, "add", ".");
	const reader = new SessionPendingFiles(root);
	let snapshot = await refresh(reader, root, candidates(file));
	assert.equal(snapshot.rows[0].added, 1);
	assert.match((await reader.preview(snapshot.rows[0]))[0].title, /empty tree/);
	git(root, "commit", "-qm", "initial");
	git(root, "mv", file, "renamed.txt");
	snapshot = await refresh(reader, root, candidates(file, "renamed.txt"));
	assert.equal(snapshot.rows.length, 1);
	assert.equal(snapshot.rows[0].path, "renamed.txt");
	assert.equal(snapshot.rows[0].added, 0);
	assert.match((await reader.preview(snapshot.rows[0]))[0].message ?? "", /→ renamed/);
	git(root, "commit", "-qm", "rename");
	assert.equal((await refresh(reader, root, candidates(file, "renamed.txt"))).changedPaths.size, 0);
});

test("non-Git, ignored, absent, binary, oversized and source line limits", async (t) => {
	const root = await fixture(t);
	const outside = await fixture(t, false);
	await writeFile(path.join(root, ".gitignore"), "ignored*\n");
	await writeFile(path.join(root, "ignored.txt"), "ignored\n");
	await writeFile(path.join(outside, "plain.txt"), "plain\n");
	await writeFile(path.join(root, "binary"), Buffer.from([1, 0, 2]));
	await writeFile(path.join(root, "huge"), "a".repeat(1024 * 1024 + 1));
	await writeFile(path.join(root, "lines"), "a\n".repeat(20_001));
	const reader = new SessionPendingFiles(root);
	const snapshot = await refresh(
		reader,
		root,
		candidates(
			"ignored.txt",
			"ignored-absent",
			path.join(outside, "plain.txt"),
			path.join(outside, "absent"),
			"binary",
			"huge",
			"lines",
		),
	);
	assert.deepEqual(
		snapshot.rows.map((row) => row.state),
		["unavailable", "clean", "unavailable", "clean", "pending", "pending", "pending"],
	);
	for (const row of snapshot.rows) assert.equal(row.added, undefined);
	assert.equal(snapshot.changedPaths.size, 3);
	assert.match(snapshot.rows[4].reason ?? "", /Binary/);
	assert.match(snapshot.rows[5].reason ?? "", /large/);
	assert.match(snapshot.rows[6].reason ?? "", /lines/);
	git(root, "add", "binary", "huge");
	const staged = await refresh(reader, root, candidates("binary", "huge"));
	assert.equal(staged.rows[0].state, "pending");
	assert.equal(staged.rows[0].added, undefined);
	assert.match(staged.rows[0].reason ?? "", /Binary/);
	assert.match((await reader.preview(staged.rows[1]))[0].message ?? "", /limit/);
});

test("conflicts retain explicit pending state, never aggregate counts", async (t) => {
	const root = await fixture(t);
	await base(root);
	const branch = git(root, "branch", "--show-current").trim();
	git(root, "checkout", "-qb", "other");
	await writeFile(path.join(root, "file.txt"), "other\n");
	git(root, "commit", "-qam", "other");
	git(root, "checkout", "-q", branch);
	await writeFile(path.join(root, "file.txt"), "main\n");
	git(root, "commit", "-qam", "main");
	assert.throws(() => git(root, "merge", "other"));
	const reader = new SessionPendingFiles(root);
	const row = (await refresh(reader, root)).rows[0];
	assert.equal(row.state, "pending");
	assert.equal(row.added, undefined);
	assert.match(row.reason ?? "", /Conflict/);
	assert.match((await reader.preview(row))[0].message ?? "", /unmerged/);
});

test("NUL parsers preserve rename/copy, tabs and newlines; Windows identity is not lowercased", () => {
	const raw = "2 R. N... 100644 100644 100644 a b R100 new\nname\0old\tname\0";
	const snapshot = parseGitSnapshot(raw);
	assert.equal(snapshot.paths[0].oldPath, "old\tname");
	assert.equal(snapshot.paths[0].path, "new\nname");
	const stats = parseNumstat("2\t1\t\0old\tname\0new\nname\0-\t-\tbinary\0");
	assert.deepEqual(stats.get("new\nname"), { added: 2, removed: 1 });
	assert.equal(stats.get("binary"), undefined);
	assert.equal(absoluteCandidate("c:\\Project", "./Src\\FILE.ts", path.win32), "C:\\Project\\Src\\FILE.ts");
	assert.equal(absoluteCandidate("\\\\server\\share\\root", "..\\file", path.win32), "\\\\server\\share\\file");
	assert.notEqual(absoluteCandidate("/tmp", "File", path.posix), absoluteCandidate("/tmp", "file", path.posix));
});

test("failures are unavailable; stale/disposed completions cannot publish; no-candidate work is zero", async () => {
	const root = path.resolve("fake-project");
	const snapshot = { ...parseGitSnapshot("? file.txt\0"), root };
	const io = {
		owner: async () => root,
		repositoryStamp: async () => "stable",
		stamp: async () => "exists",
		text: async () => "new\n",
	};
	const denied = new SessionPendingFiles(root, {
		...io,
		owner: async () => {
			throw new Error("EACCES");
		},
	});
	assert.equal((await denied.reconcile(candidates("file.txt"), snapshot))?.rows[0].state, "unavailable");
	const failed = new SessionPendingFiles(root, io);
	assert.equal((await failed.reconcile(candidates("file.txt"), undefined))?.rows[0].state, "unavailable");
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const reader = new SessionPendingFiles(root, {
		...io,
		text: async () => {
			await gate;
			return "new\n";
		},
	});
	const late = reader.reconcile(candidates("file.txt"), snapshot);
	const latest = await reader.reconcile([], snapshot);
	release?.();
	assert.equal(await late, undefined);
	assert.equal(reader.snapshot, latest);
	reader.dispose();
	assert.equal(await reader.reconcile(candidates("file.txt"), snapshot), undefined);
	const empty = new SessionPendingFiles(root, {
		owner: async () => {
			throw new Error("must not call");
		},
	});
	assert.equal((await empty.reconcile([], undefined))?.rows.length, 0);
});

test("Explorer dots use the verified snapshot; outside browsing adds no Git scan", async (t) => {
	const root = await fixture(t);
	const other = await fixture(t, false);
	await base(root);
	await writeFile(path.join(root, "file.txt"), "dirty\n");
	let scans = 0;
	const location = new ExplorerLocation(root, () => {}, {
		git: async (cwd, prefix, signal) => {
			scans++;
			return readGitSnapshot(cwd, prefix, signal);
		},
	});
	t.after(async () => location.dispose());
	const reader = new SessionPendingFiles(root);
	let snapshot = await reader.reconcile(candidates("file.txt"), await location.refresh(undefined, []));
	assert.ok(snapshot);
	assert.ok(location.sessionChanges(snapshot.changedPaths).has("file.txt"));
	await location.go(other);
	assert.equal(scans, 1);
	git(root, "restore", "file.txt");
	snapshot = await reader.reconcile(candidates("file.txt"), await location.refresh(undefined, []));
	assert.ok(snapshot);
	assert.equal(snapshot.changedPaths.size, 0);
	assert.equal(scans, 2);
});

test("bounded Git reader rejects cancellation/truncation and bounded text reader rejects directories", async (t) => {
	const root = await fixture(t);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(pendingGit(root, ["status"], controller.signal));
	await assert.rejects(pendingGit(root, ["status"], new AbortController().signal, 1), /limit/);
	await assert.rejects(currentText(root), /unsupported/);
	assert.deepEqual(collectSessionFileChanges([], root), []);
});
