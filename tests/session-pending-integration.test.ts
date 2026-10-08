import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { parseGitSnapshot, readGitSnapshot } from "../src/git-status.ts";
import { MidnightPanels } from "../src/index.ts";
import { SessionAnalysis } from "../src/session-analysis.ts";
import { collectSessionFileChanges } from "../src/session-file-changes.ts";
import { SessionPendingFiles } from "../src/session-pending-files.ts";
import { pendingGit } from "../src/session-pending-io.ts";
import { Sidebar } from "../src/sidebar.ts";

const cwd = path.resolve("test-project");
const history: SessionEntry[] = [
	{
		id: "call",
		parentId: null,
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "file.txt", content: "historical\n" } },
			],
		},
	},
	{
		id: "result",
		parentId: "call",
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "write-1",
			toolName: "write",
			isError: false,
			content: [{ type: "text", text: "written" }],
		},
	},
] as unknown as SessionEntry[];
function fakeContext() {
	let scans = 0;
	const manager = {
		getSessionId: () => "id",
		getEntryCount: () => history.length,
		getLeafId: () => "result",
		getEntries: () => {
			scans++;
			return history;
		},
		getBranch: () => {
			scans++;
			return history;
		},
		getSessionName: () => "test",
		getEntry: (id: string) => history.find((entry) => entry.id === id),
	};
	const ctx = {
		cwd,
		sessionManager: manager,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		model: undefined,
		ui: { theme: { fg: (_: string, text: string) => text, bold: (text: string) => text } },
	} as unknown as ExtensionContext;
	return { ctx, scans: () => scans };
}
const io = {
	identity: async (file: string) => file,
	owner: async () => cwd,
	repositoryStamp: async () => "stable",
	stamp: async () => "exists",
	text: async () => "current\n",
};

test("reload/sidebar uses provenance only as candidates; stable renders do no I/O or history scans", async () => {
	const { ctx, scans } = fakeContext();
	const sidebar = new Sidebar(
		() => ctx,
		{ getActiveTools: () => [], getThinkingLevel: () => "off" } as unknown as ExtensionAPI,
		() => 80,
		() => {},
		() => {},
	);
	sidebar.refresh();
	assert.equal(sidebar.candidates.length, 1);
	assert.equal(scans(), 2);
	assert.equal(sidebar.changedPaths.size, 0);
	assert.doesNotMatch(sidebar.render(36).join("\n"), /SESSION FILES|\+2/);
	const reader = new SessionPendingFiles(cwd, io);
	const dirty = await reader.reconcile(sidebar.candidates, { ...parseGitSnapshot("? file.txt\0"), root: cwd });
	assert.ok(dirty);
	sidebar.publish(dirty);
	assert.match(sidebar.render(36).join("\n"), /SESSION FILES \(1\)/);
	assert.ok(sidebar.changedPaths.has("file.txt"));
	for (let i = 0; i < 10; i++) {
		sidebar.refresh();
		sidebar.render(36);
	}
	assert.equal(scans(), 2);
	sidebar.updating = true;
	sidebar.invalidate();
	assert.match(sidebar.render(36).join("\n"), /Previous snapshot/);
	assert.ok(sidebar.changedPaths.has("file.txt"));
	const clean = await reader.reconcile(sidebar.candidates, { ...parseGitSnapshot(""), root: cwd });
	assert.ok(clean);
	sidebar.publish(clean);
	assert.equal(sidebar.changedPaths.size, 0);
	assert.doesNotMatch(sidebar.render(36).join("\n"), /SESSION FILES/);
	assert.equal(sidebar.candidates.length, 1);
	assert.equal(sidebar.candidates[0].edits[0].content, "historical\n");
	const unavailable = await reader.reconcile(sidebar.candidates, undefined);
	assert.ok(unavailable);
	sidebar.publish(unavailable);
	assert.match(sidebar.render(36).join("\n"), /RECORDED FILES/);
	assert.equal(sidebar.changedPaths.size, 0);
	sidebar.dispose();
	reader.dispose();
});

test("conversation branch navigation rebuilds touched candidates, not disk or transcript", () => {
	const { ctx, scans } = fakeContext();
	const analysis = new SessionAnalysis();
	analysis.update(ctx.sessionManager, cwd);
	assert.equal(analysis.changes.length, 1);
	analysis.update(ctx.sessionManager, cwd);
	assert.equal(scans(), 2);
	const alternate = { ...ctx.sessionManager, getLeafId: () => null, getBranch: () => [] };
	analysis.update(alternate, cwd);
	assert.equal(analysis.changes.length, 0);
	analysis.update(ctx.sessionManager, cwd);
	assert.equal(analysis.changes.length, 1);
});

test("refresh coordinator coalesces a burst into one follow-up and awaits it", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((done) => {
		release = done;
	});
	let runs = 0;
	let reconciles = 0;
	// Test the real refresh flow with fake UI parts. No terminal or model calls.
	const panels = Object.assign(Object.create(MidnightPanels.prototype), {
		disposed: false,
		pendingRefresh: false,
		controller: new AbortController(),
		previewGeneration: 0,
		sidebar: { candidates: [], refresh() {}, invalidate() {}, publish() {} },
		layout: { visibility: () => ({ explorer: false }) },
		tui: { requestRender() {} },
		workspace: {
			refresh: async () => {
				runs++;
				if (runs === 1) await gate;
				return undefined;
			},
		},
		pendingFiles: {
			cancel() {},
			reconcile: async () => {
				reconciles++;
				return { rows: [] };
			},
		},
	}) as MidnightPanels;
	const first = panels.refreshFiles();
	for (let i = 0; i < 20; i++) assert.equal(panels.refreshFiles(), first);
	release?.();
	await first;
	assert.equal(runs, 2);
	assert.equal(reconciles, 2);
});

test("cancellation discards an actual in-flight read; permission/concurrent failures are not clean", async () => {
	const candidates = collectSessionFileChanges(history, cwd);
	const snapshot = { ...parseGitSnapshot("? file.txt\0"), root: cwd };
	let release: (() => void) | undefined;
	let started: (() => void) | undefined;
	const gate = new Promise<void>((done) => {
		release = done;
	});
	const reading = new Promise<void>((done) => {
		started = done;
	});
	const reader = new SessionPendingFiles(cwd, {
		...io,
		text: async () => {
			started?.();
			await gate;
			return "new\n";
		},
	});
	const late = reader.reconcile(candidates, snapshot);
	await reading;
	reader.dispose();
	release?.();
	assert.equal(await late, undefined);
	assert.equal(reader.snapshot.generation, 0);
	const denied = new SessionPendingFiles(cwd, {
		...io,
		stamp: async () => {
			throw new Error("permission denied");
		},
	});
	assert.equal((await denied.reconcile(candidates, { ...snapshot, paths: [] }))?.rows[0].state, "unavailable");
	let revision = 0;
	const racing = new SessionPendingFiles(cwd, { ...io, repositoryStamp: async () => String(revision++) });
	const race = await racing.reconcile(candidates, snapshot);
	assert.equal(race?.rows[0].state, "unavailable");
	assert.equal(race?.changedPaths.size, 0);
});

test("copy source is not attributed, mode/type/submodule states have no fictional counts", async () => {
	const candidates = collectSessionFileChanges(history, cwd);
	const reader = new SessionPendingFiles(cwd, io);
	const copy = { ...parseGitSnapshot("2 C. N... 100644 100644 100644 a b C100 copy.txt\0file.txt\0"), root: cwd };
	assert.equal((await reader.reconcile(candidates, copy))?.rows[0].state, "clean");
	for (const raw of [
		"1 .M N... 100644 100644 100755 a b file.txt\0",
		"1 .T N... 100644 100644 120000 a b file.txt\0",
		"1 .M S.M. 160000 160000 160000 a b file.txt\0",
	]) {
		const row = (await reader.reconcile(candidates, { ...parseGitSnapshot(raw), root: cwd }))?.rows[0];
		assert.equal(row?.state, "pending");
		assert.equal(row.added, undefined);
		assert.ok(row.reason);
	}
});

test("real Git batches counts, reads patches only on click, and supports linked worktrees", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "midnight-batch-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
	git("init", "-q");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.invalid");
	git("config", "core.autocrlf", "false");
	const files = Array.from({ length: 12 }, (_, i) => `file${i}.txt`);
	for (const file of files) await writeFile(path.join(root, file), "before\n");
	git("add", ".");
	git("commit", "-qm", "base");
	for (const file of files) await writeFile(path.join(root, file), "after\nmore\n");
	let counts = 0;
	let patches = 0;
	const reader = new SessionPendingFiles(root, {
		git: (cwd, args, signal) => {
			if (args.includes("--numstat")) counts++;
			if (args.includes("--patch")) patches++;
			return pendingGit(cwd, args, signal);
		},
	});
	const candidates = files.map((file) => ({ path: file, added: 999, removed: 999, edits: [] }));
	const snapshot = await reader.reconcile(candidates, await readGitSnapshot(root, ""));
	assert.ok(snapshot);
	assert.equal(counts, 1);
	assert.equal(patches, 0);
	assert.ok(snapshot.rows.every((row) => row.added === 2 && row.removed === 1));
	await reader.preview(snapshot.rows[0]);
	assert.equal(patches, 1);
	const worktree = path.join(root, "linked");
	git("worktree", "add", "-qb", "linked", worktree);
	await writeFile(path.join(worktree, files[0]), "linked change\n");
	const linked = await reader.reconcile(
		[{ ...candidates[0], path: path.join(worktree, files[0]) }],
		await readGitSnapshot(root, ""),
	);
	assert.equal(linked?.rows[0].root, worktree);
	assert.equal(linked?.rows[0].state, "pending");
});
