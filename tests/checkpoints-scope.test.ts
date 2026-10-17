import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	captureCheckpoint,
	git,
	loadCheckpoints,
	prepareRestore,
	readRestoreRecovery,
	restoreCheckpoint,
	type StoredCheckpoint,
} from "../src/checkpoints/core.ts";
import {
	type CheckpointStep,
	checkpointSteps,
	registerCheckpoints,
	restoreEffects,
	restorePaths,
	restoreScope,
} from "../src/checkpoints/index.ts";

const options = { sessionId: "scope-session", entryId: null, trigger: "turn" as const };

async function fixture(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "midnight checkpoint-scope-"));
	t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
	await git(root, ["init", "-q", "--initial-branch=main"]);
	await git(root, ["config", "user.name", "Scope Test"]);
	await git(root, ["config", "user.email", "scope@local.invalid"]);
	await git(root, ["config", "core.autocrlf", "false"]);
	await writeFile(join(root, "a.txt"), "base\n");
	await writeFile(join(root, "own.txt"), "base\n");
	await git(root, ["add", "--", "a.txt", "own.txt"]);
	await git(root, ["commit", "-qm", "base"]);
	return root;
}

// Uses the production step builder (src/checkpoints/index.ts), so a change there is exercised here.
const steps = (root: string, checkpoints: readonly StoredCheckpoint[]): Promise<CheckpointStep[]> =>
	checkpointSteps(root, checkpoints);

test("restore scope keeps only steps after the target and still reports later files as deletions", async (t) => {
	const root = await fixture(t);
	// The app hands every capture the session's accumulated observed union, so checkpoint scopes only grow:
	// the session-wide union therefore still names paths last touched before the target.
	await writeFile(join(root, "a.txt"), "observed before the target\n");
	const observed = ["a.txt"];
	const first = await captureCheckpoint(root, { ...options, scope: observed });
	await writeFile(join(root, "b.txt"), "created at the target\n");
	observed.push("b.txt");
	const target = await captureCheckpoint(root, { ...options, scope: observed, previous: first });
	await writeFile(join(root, "c.txt"), "created after the target\n");
	observed.push("c.txt");
	const latest = await captureCheckpoint(root, { ...options, scope: observed, previous: target });

	assert.ok(latest.scope.includes("a.txt"), "monotone scopes keep a.txt in the session union");
	assert.deepEqual(
		restoreScope(await steps(root, [first, target, latest]), target.ref),
		["c.txt"],
		"a.txt and the target's own step stay out of the restore set",
	);
	const plan = await prepareRestore(root, target, ["c.txt"]);
	assert.deepEqual(plan.changes, [{ path: "c.txt", worktree: true, index: false, deletion: true }]);
});

test("restore scope selects steps after the target and refuses an unknown target", () => {
	const synthetic: CheckpointStep[] = [
		{ ref: "one", changed: ["early.txt"] },
		{ ref: "two", changed: ["mid.txt"] },
		{ ref: "three", changed: ["late.txt", "mid.txt"] },
	];
	assert.deepEqual(restoreScope(synthetic, "two"), ["late.txt", "mid.txt"]);
	assert.deepEqual(restoreScope(synthetic, "three"), []);
	assert.deepEqual(restoreScope(synthetic, "one"), ["late.txt", "mid.txt"]);
	assert.throws(() => restoreScope(synthetic, "absent"), /not part of the current checkpoint branch/);
});

test("a scoped restore leaves later work the checkpoint timeline never recorded byte-identical", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "own.txt"), "tool edit before the target\n");
	const observed = ["own.txt"];
	const first = await captureCheckpoint(root, { ...options, scope: observed });
	await writeFile(join(root, "a.txt"), "target edit\n");
	observed.push("a.txt");
	const target = await captureCheckpoint(root, { ...options, scope: observed, previous: first });
	await writeFile(join(root, "b.txt"), "created at the target\n");
	observed.push("b.txt");
	const latest = await captureCheckpoint(root, { ...options, scope: observed, previous: target });
	// own.txt was observed earlier, so the session-wide union would reconcile it too; no checkpoint recorded
	// this edit, so it stays outside the computed set.
	await writeFile(join(root, "own.txt"), "unrecorded work\n");
	const head = (await git(root, ["rev-parse", "HEAD"])).toString("utf8").trim();

	const paths = restoreScope(await steps(root, [first, target, latest]), target.ref);
	assert.deepEqual(paths, ["b.txt"]);
	const backup = await restoreCheckpoint(root, await prepareRestore(root, target, paths), options);

	assert.equal(backup.trigger, "before-restore");
	assert.equal(await readFile(join(root, "own.txt"), "utf8"), "unrecorded work\n");
	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "target edit\n");
	await assert.rejects(readFile(join(root, "b.txt")), { code: "ENOENT" });
	assert.equal((await git(root, ["rev-parse", "HEAD"])).toString("utf8").trim(), head);
});

const revParse = async (root: string, rev: string): Promise<string> =>
	(await git(root, ["rev-parse", rev])).toString("utf8").trim();

test("a stale plan is refused once HEAD moves, and a branch switch refuses any restore", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "a.txt"), "pending\n");
	const checkpoint = await captureCheckpoint(root, { ...options, scope: ["a.txt"] });
	await writeFile(join(root, "a.txt"), "later\n");
	const plan = await prepareRestore(root, checkpoint, ["a.txt"]);
	assert.equal(plan.head, undefined, "HEAD has not moved yet");

	await git(root, ["add", "--", "a.txt"]);
	await git(root, ["commit", "-qm", "advance"]);
	await assert.rejects(restoreCheckpoint(root, plan, options), /changed after the preview/);
	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "later\n");

	await git(root, ["checkout", "-q", "-b", "other"]);
	await assert.rejects(prepareRestore(root, checkpoint, ["a.txt"]), /taken on main, not the current other/);
});

test("a restore across later commits moves the branch back and restores files and staged state", async (t) => {
	const root = await fixture(t);
	const base = await revParse(root, "HEAD");
	await writeFile(join(root, "a.txt"), "checkpoint edit\n");
	const checkpoint = await captureCheckpoint(root, { ...options, scope: ["a.txt"] });
	// The agent commits its work, adds a file in another commit, then leaves an uncommitted edit.
	await git(root, ["commit", "-qam", "commit a"]);
	await writeFile(join(root, "new.txt"), "added later\n");
	await git(root, ["add", "--", "new.txt"]);
	await git(root, ["commit", "-qm", "add new"]);
	await writeFile(join(root, "own.txt"), "edited later\n");
	const tip = await revParse(root, "HEAD");

	const plan = await prepareRestore(root, checkpoint, []);
	assert.deepEqual(
		plan.head && { ref: plan.head.ref, from: plan.head.from, to: plan.head.to, leaving: plan.head.leaving },
		{ ref: "refs/heads/main", from: tip, to: base, leaving: 2 },
	);
	assert.deepEqual(
		plan.head?.commits.map((line) => line.split(" ").slice(1).join(" ")),
		["add new", "commit a"],
	);
	assert.deepEqual(
		plan.changes.map((change) => change.path),
		["a.txt", "new.txt"],
		"commit paths are reconciled; the unrecorded own.txt edit is not",
	);
	const backup = await restoreCheckpoint(root, plan, options);

	assert.equal(await revParse(root, "HEAD"), base, "the branch points at the checkpoint's commit");
	assert.equal((await git(root, ["symbolic-ref", "HEAD"])).toString("utf8").trim(), "refs/heads/main");
	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "checkpoint edit\n");
	await assert.rejects(readFile(join(root, "new.txt")), { code: "ENOENT" });
	assert.equal(await readFile(join(root, "own.txt"), "utf8"), "edited later\n");
	assert.equal(
		(await git(root, ["status", "--porcelain"])).toString("utf8"),
		" M a.txt\n M own.txt\n",
		"the staged layer matches the checkpoint: a.txt was an unstaged edit then",
	);
	assert.match((await git(root, ["reflog", "-1", "--format=%gs", "main"])).toString("utf8"), /midnight: rewind/);
	assert.equal(backup.head, tip, "the recovery checkpoint keeps the old tip reachable");
});

// ---------------------------------------------------------------------------
// Production command coupling: these drive registerCheckpoints().command with a
// small injected Pi context instead of duplicating the step builder or the guard.
// ---------------------------------------------------------------------------

interface StubEntry {
	type: string;
	id: string;
	customType?: string;
	data?: unknown;
}

interface RewindHarness {
	command(args: string): Promise<void>;
	entries: StubEntry[];
	notices: string[];
	navigations: string[];
	restores: () => number;
	queueSelect(...picks: ((choices: string[]) => string | undefined)[]): void;
	setPreviewAccept(accept: boolean): void;
	setConfirmAccept(accept: boolean): void;
	start(): Promise<void>;
}

const pickBy = (needle: string) => (choices: string[]) => choices.find((choice) => choice.includes(needle));

function checkpointEntry(checkpoint: StoredCheckpoint, id: string): StubEntry {
	return { type: "custom", id, customType: "midnight-checkpoint", data: { version: 1, ref: checkpoint.ref } };
}

function rewindHarness(root: string, seed: StubEntry[] = []): RewindHarness {
	const entries = [...seed];
	const notices: string[] = [];
	const navigations: string[] = [];
	const selects: ((choices: string[]) => string | undefined)[] = [];
	let previewAccept = true;
	let confirmAccept = true;
	let restoreCount = 0;
	let sequence = 0;
	const ui = {
		notify: (message: string) => {
			notices.push(message);
		},
		select: async (_title: string, choices: string[]) => (selects.shift() ?? (() => undefined))(choices),
		confirm: async () => confirmAccept,
		custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: boolean) => void) => unknown) =>
			await new Promise<boolean>((resolve) => {
				const done = (value: boolean) => resolve(value);
				factory({ terminal: { columns: 80, rows: 24 }, requestRender: () => {} }, {}, [], done);
				queueMicrotask(() => done(previewAccept));
			}),
	};
	const ctx = {
		cwd: root,
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui,
		sessionManager: {
			getBranch: () => entries,
			getEntries: () => entries,
			getSessionId: () => "scope-session",
			getLeafId: () => "leaf-1",
		},
		navigateTree: async (entryId: string) => {
			navigations.push(entryId);
			return { cancelled: false };
		},
	} as unknown as ExtensionCommandContext;
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ type: "custom", id: `stub-${++sequence}`, customType, data });
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	const controller = registerCheckpoints(
		pi,
		() => true,
		() => {
			restoreCount++;
		},
	);
	return {
		command: (args: string) => controller.command(args, ctx),
		entries,
		notices,
		navigations,
		restores: () => restoreCount,
		queueSelect: (...picks) => selects.push(...picks),
		setPreviewAccept: (accept) => {
			previewAccept = accept;
		},
		setConfirmAccept: (accept) => {
			confirmAccept = accept;
		},
		start: async () => {
			for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		},
	};
}

const countRefs = async (root: string): Promise<number> =>
	(await git(root, ["for-each-ref", "--format=%(refname)", "refs/midnight/checkpoints/"]))
		.toString("utf8")
		.split("\n")
		.filter(Boolean).length;

test("restorePaths adds recorded restores and an imported snapshot's own pending paths", () => {
	const captured = {
		ref: "captured",
		timestamp: 1000,
		scope: [],
		provenance: undefined,
	} as unknown as StoredCheckpoint;
	const imported = {
		ref: "imported",
		timestamp: 500,
		scope: ["legacy.txt"],
		provenance: "legacy-import",
	} as unknown as StoredCheckpoint;
	const steps: CheckpointStep[] = [
		{ ref: "older", changed: ["before.txt"] },
		{ ref: "captured", changed: ["b.txt"] },
		{ ref: "newer", changed: ["c.txt"] },
	];

	assert.deepEqual(restorePaths(steps, [], captured), ["c.txt"], "plain recorded deltas after the target");
	assert.deepEqual(
		restorePaths(steps, [{ at: 2000, paths: ["undone.txt"] }], captured),
		["c.txt", "undone.txt"],
		"a restore confirmed after the target is reconciled too",
	);
	assert.deepEqual(
		restorePaths(steps, [{ at: 500, paths: ["earlier.txt"] }], captured),
		["c.txt"],
		"restores older than the target are already part of its own snapshot",
	);
	assert.deepEqual(
		restoreScope([{ ref: "imported", changed: [] }], "imported"),
		[],
		"the pre-fix delta-only scope alone is empty, so the imported fallback is what restores files",
	);
	assert.deepEqual(
		restorePaths([{ ref: "imported", changed: [] }], [], imported),
		["legacy.txt"],
		"an imported snapshot falls back to the pending paths it recorded",
	);
	assert.deepEqual(
		restorePaths([{ ref: "captured", changed: ["before.txt"] }], [], captured),
		[],
		"the newest captured checkpoint has no later delta",
	);
});

test("a combined rewind that changes no files still navigates the conversation", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "a.txt"), "pending\n");
	const newest = await captureCheckpoint(root, { ...options, scope: ["a.txt"], entryId: "conv-1" });
	const harness = rewindHarness(root, [checkpointEntry(newest, "seed-1"), { type: "message", id: "conv-1" }]);
	await harness.start();
	const refsBefore = await countRefs(root);

	harness.queueSelect(pickBy(newest.id.slice(0, 8)), () => "Files and conversation");
	await harness.command("");

	assert.deepEqual(harness.navigations, ["conv-1"], "the requested conversation navigation still happens");
	assert.equal(harness.restores(), 0, "no file restore ran");
	assert.equal(await countRefs(root), refsBefore, "no recovery checkpoint was taken");
	assert.ok(
		harness.notices.some((notice) => notice.includes("no files were restored")),
		"the outcome is reported honestly",
	);
	assert.ok(
		!harness.notices.some((notice) => notice.includes("Restore completed")),
		"a skipped file restore is never reported as a completed restore",
	);
	assert.ok(
		!harness.entries.some((entry) => entry.customType === "midnight-checkpoint-redo"),
		"no redo step is recorded for a skipped restore",
	);
});

test("a rewind can undo Midnight's own restore before another snapshot is captured", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "a.txt"), "pending\n");
	const first = await captureCheckpoint(root, { ...options, scope: ["a.txt", "own.txt"] });
	await writeFile(join(root, "b.txt"), "created\n");
	const target = await captureCheckpoint(root, {
		...options,
		scope: ["a.txt", "b.txt", "own.txt"],
		previous: first,
		entryId: "conv-2",
	});
	const harness = rewindHarness(root, [checkpointEntry(first, "seed-1"), checkpointEntry(target, "seed-2")]);
	await harness.start();

	// Rewind to the older checkpoint: b.txt exists only afterwards, so it is deleted.
	harness.queueSelect(pickBy(first.id.slice(0, 8)), () => "Files only");
	await harness.command("");
	await assert.rejects(readFile(join(root, "b.txt")), { code: "ENOENT" });
	assert.equal(harness.restores(), 1);

	// Unrecorded work on a path the timeline never changed after the target must survive.
	await writeFile(join(root, "own.txt"), "unrecorded\n");

	// Rewinding to the newer checkpoint must bring back what Midnight's own restore removed,
	// even though no checkpoint was captured in between.
	harness.queueSelect(pickBy(target.id.slice(0, 8)), () => "Files only");
	await harness.command("");
	assert.equal(await readFile(join(root, "b.txt"), "utf8"), "created\n");
	assert.equal(await readFile(join(root, "own.txt"), "utf8"), "unrecorded\n");
	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "pending\n");
	assert.equal(harness.restores(), 2);

	// The bookkeeping that makes this work is persisted in the session, so a reload can reload it.
	const redoEntry = [...harness.entries].reverse().find((entry) => entry.customType === "midnight-checkpoint-redo");
	const steps = (redoEntry?.data as { steps: { ref: string; paths: string[]; changed?: string[] }[] }).steps;
	assert.deepEqual(
		steps.map((step) => step.changed),
		[["b.txt"], ["b.txt"]],
		"each step records the paths that restore actually changed",
	);
	const loaded = await loadCheckpoints(
		root,
		steps.map((step) => step.ref),
	);
	const effects = restoreEffects(
		steps.map((step) => ({
			checkpoint: loaded.get(step.ref) as StoredCheckpoint,
			paths: step.paths,
			changed: step.changed,
		})),
	);
	assert.equal(effects.length, 2, "both confirmed restores are recorded in the session");
	for (const effect of effects) {
		assert.deepEqual(effect.paths, ["b.txt"]);
		assert.ok(effect.at > target.timestamp, "a recorded restore is newer than the checkpoint it can undo");
	}
});

test("a files-only restore of an imported legacy snapshot still restores files", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "a.txt"), "imported\n");
	const source = await captureCheckpoint(root, { ...options, sessionId: "legacy-session", scope: ["a.txt"] });
	const body = [
		"sessionId scope-session",
		`index-tree ${source.indexTree}`,
		`worktree-tree ${source.worktreeTree}`,
		`head ${(await git(root, ["rev-parse", "HEAD"])).toString("utf8").trim()}`,
		`branch ${(await git(root, ["symbolic-ref", "-q", "HEAD"])).toString("utf8").trim()}`,
		`created ${new Date().toISOString()}`,
	].join("\n");
	const commit = (await git(root, ["commit-tree", source.worktreeTree], { input: body })).toString("utf8").trim();
	await git(root, ["update-ref", `refs/pi-checkpoints/legacy-${commit.slice(0, 8)}`, commit]);
	await writeFile(join(root, "a.txt"), "current\n");

	const harness = rewindHarness(root);
	await harness.start();
	harness.queueSelect((choices) => choices[0]);
	await harness.command("import");
	assert.ok(
		harness.entries.some((entry) => entry.customType === "midnight-checkpoint"),
		"the import recorded a checkpoint entry",
	);

	harness.queueSelect(
		(choices) => choices[0],
		() => "Files only",
	);
	await harness.command("");
	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "imported\n");
	assert.equal(harness.restores(), 1);
	assert.ok(
		harness.notices.some((notice) => notice.includes("Restore completed")),
		"the imported files-only restore reports a completed restore",
	);
});

test("declining the read-only preview writes nothing", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "a.txt"), "pending\n");
	const first = await captureCheckpoint(root, { ...options, scope: ["a.txt"] });
	await writeFile(join(root, "b.txt"), "created\n");
	const target = await captureCheckpoint(root, { ...options, scope: ["a.txt", "b.txt"], previous: first });
	const harness = rewindHarness(root, [checkpointEntry(first, "seed-1"), checkpointEntry(target, "seed-2")]);
	await harness.start();
	const refsBefore = await countRefs(root);
	harness.setPreviewAccept(false);

	harness.queueSelect(pickBy(first.id.slice(0, 8)), () => "Files only");
	await harness.command("");

	assert.equal(await readFile(join(root, "b.txt"), "utf8"), "created\n", "no file was changed");
	assert.equal(harness.restores(), 0);
	assert.equal(await countRefs(root), refsBefore, "no recovery checkpoint was taken");
	assert.ok(!harness.notices.some((notice) => notice.includes("Restore completed")));
});

test("declining the confirmation dialog writes nothing", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "a.txt"), "pending\n");
	const first = await captureCheckpoint(root, { ...options, scope: ["a.txt"] });
	await writeFile(join(root, "b.txt"), "created\n");
	const target = await captureCheckpoint(root, { ...options, scope: ["a.txt", "b.txt"], previous: first });
	const harness = rewindHarness(root, [checkpointEntry(first, "seed-1"), checkpointEntry(target, "seed-2")]);
	await harness.start();
	const refsBefore = await countRefs(root);
	harness.setConfirmAccept(false);

	harness.queueSelect(pickBy(first.id.slice(0, 8)), () => "Files only");
	await harness.command("");

	assert.equal(await readFile(join(root, "b.txt"), "utf8"), "created\n", "no file was changed");
	assert.equal(harness.restores(), 0);
	assert.equal(await countRefs(root), refsBefore, "a declined confirmation takes no recovery checkpoint");
	assert.ok(!harness.entries.some((entry) => entry.customType === "midnight-checkpoint-redo"));
});

test("a rewind whose candidates already match reports nothing to restore and takes no backup", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "a.txt"), "pending\n");
	const first = await captureCheckpoint(root, { ...options, scope: ["a.txt"] });
	await writeFile(join(root, "b.txt"), "created\n");
	const target = await captureCheckpoint(root, { ...options, scope: ["a.txt", "b.txt"], previous: first });
	const harness = rewindHarness(root, [checkpointEntry(first, "seed-1"), checkpointEntry(target, "seed-2")]);
	await harness.start();
	// The candidate set is non-empty (b.txt was created after the target) but b.txt is already gone,
	// so the restore plan has no changes and must not take a recovery checkpoint or a redo step.
	await rm(join(root, "b.txt"));
	const refsBefore = await countRefs(root);

	harness.queueSelect(pickBy(first.id.slice(0, 8)), () => "Files only");
	await harness.command("");

	assert.equal(harness.restores(), 0);
	assert.equal(await countRefs(root), refsBefore, "no recovery checkpoint was taken");
	assert.ok(
		harness.notices.some((notice) => notice.includes("already match this checkpoint")),
		"the no-op is reported honestly",
	);
	assert.ok(!harness.notices.some((notice) => notice.includes("Restore completed")));
	assert.ok(!harness.entries.some((entry) => entry.customType === "midnight-checkpoint-redo"));
});

async function importLegacyRef(root: string, source: StoredCheckpoint): Promise<void> {
	const body = [
		"sessionId scope-session",
		`index-tree ${source.indexTree}`,
		`worktree-tree ${source.worktreeTree}`,
		`head ${(await git(root, ["rev-parse", "HEAD"])).toString("utf8").trim()}`,
		`branch ${(await git(root, ["symbolic-ref", "-q", "HEAD"])).toString("utf8").trim()}`,
		`created ${new Date().toISOString()}`,
	].join("\n");
	const commit = (await git(root, ["commit-tree", source.worktreeTree], { input: body })).toString("utf8").trim();
	await git(root, ["update-ref", `refs/pi-checkpoints/legacy-${commit.slice(0, 8)}`, commit]);
}

test("an imported legacy snapshot adds no delta to an ordinary rewind", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "a.txt"), "one\n");
	const target = await captureCheckpoint(root, { ...options, scope: ["a.txt"] });
	// A legacy snapshot of a different pending state, imported after the captured checkpoint exists.
	await writeFile(join(root, "a.txt"), "legacy\n");
	const source = await captureCheckpoint(root, { ...options, sessionId: "legacy-session", scope: ["a.txt"] });
	await importLegacyRef(root, source);
	// Back to the captured state, so the resume capture deduplicates and adds no checkpoint of its own.
	await writeFile(join(root, "a.txt"), "one\n");

	const harness = rewindHarness(root, [checkpointEntry(target, "seed-1")]);
	await harness.start();
	harness.queueSelect((choices) => choices[0]);
	await harness.command("import");
	assert.ok(
		harness.entries.some((entry) => entry.customType === "midnight-checkpoint" && entry.id !== "seed-1"),
		"the import recorded a checkpoint entry",
	);

	// An edit the timeline never recorded, on the path where the import and the target disagree.
	await writeFile(join(root, "a.txt"), "unrecorded\n");
	const refsBefore = await countRefs(root);
	harness.queueSelect(pickBy(target.id.slice(0, 8)), () => "Files only");
	await harness.command("");

	assert.equal(
		await readFile(join(root, "a.txt"), "utf8"),
		"unrecorded\n",
		"the import's own diff is not a recorded delta of the target",
	);
	assert.equal(harness.restores(), 0, "no file restore ran");
	assert.equal(await countRefs(root), refsBefore, "a no-op takes no recovery checkpoint");
	assert.ok(harness.notices.some((notice) => notice.includes("no recorded change after this checkpoint")));
});

test("captured deltas still reconcile across an interleaved import", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "a.txt"), "one\n");
	const first = await captureCheckpoint(root, { ...options, scope: ["a.txt", "own.txt"] });
	// An import that differs from the captured state on own.txt only.
	await writeFile(join(root, "own.txt"), "legacy own\n");
	const source = await captureCheckpoint(root, {
		...options,
		sessionId: "legacy-session",
		scope: ["a.txt", "own.txt"],
	});
	await importLegacyRef(root, source);
	await writeFile(join(root, "own.txt"), "base\n");

	const harness = rewindHarness(root, [checkpointEntry(first, "seed-1")]);
	await harness.start();
	harness.queueSelect((choices) => choices[0]);
	await harness.command("import");
	// A real capture after the import: only a.txt differs from the last captured checkpoint.
	await writeFile(join(root, "a.txt"), "two\n");
	await harness.command("capture");

	// Unrecorded work on the path the import, but no capture, changed relative to the target.
	await writeFile(join(root, "own.txt"), "unrecorded own\n");
	harness.queueSelect(pickBy(first.id.slice(0, 8)), () => "Files only");
	await harness.command("");

	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "one\n", "the captured delta is still reconciled");
	assert.equal(
		await readFile(join(root, "own.txt"), "utf8"),
		"unrecorded own\n",
		"an import is not the baseline for a later captured delta",
	);
});

test("a recorded restore effect covers only the paths that restore changed", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "a.txt"), "one\n");
	const older = await captureCheckpoint(root, { ...options, scope: ["a.txt", "own.txt"] });
	await writeFile(join(root, "a.txt"), "two\n");
	await writeFile(join(root, "b.txt"), "new\n");
	const newer = await captureCheckpoint(root, {
		...options,
		scope: ["a.txt", "b.txt", "own.txt"],
		previous: older,
	});
	const harness = rewindHarness(root, [checkpointEntry(older, "seed-1"), checkpointEntry(newer, "seed-2")]);
	await harness.start();

	// a.txt already matches the older checkpoint, so the restore's only real change is deleting b.txt.
	await writeFile(join(root, "a.txt"), "one\n");
	harness.queueSelect(pickBy(older.id.slice(0, 8)), () => "Files only");
	await harness.command("");
	await assert.rejects(readFile(join(root, "b.txt")), { code: "ENOENT" });
	assert.equal(harness.restores(), 1);

	// The rewind to the newer checkpoint is driven by the recorded effect; it must not touch a.txt.
	await writeFile(join(root, "a.txt"), "unrecorded\n");
	harness.queueSelect(pickBy(newer.id.slice(0, 8)), () => "Files only");
	await harness.command("");

	assert.equal(await readFile(join(root, "b.txt"), "utf8"), "new\n", "the recorded restore is still undone");
	assert.equal(
		await readFile(join(root, "a.txt"), "utf8"),
		"unrecorded\n",
		"a candidate the restore left alone is not a Midnight write",
	);
});

test("a recorded restore survives a reload and redo consumes it", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "a.txt"), "one\n");
	const older = await captureCheckpoint(root, { ...options, scope: ["a.txt", "own.txt"] });
	await writeFile(join(root, "b.txt"), "new\n");
	const newer = await captureCheckpoint(root, {
		...options,
		scope: ["a.txt", "b.txt", "own.txt"],
		previous: older,
	});
	const harness = rewindHarness(root, [checkpointEntry(older, "seed-1"), checkpointEntry(newer, "seed-2")]);
	await harness.start();
	harness.queueSelect(pickBy(older.id.slice(0, 8)), () => "Files only");
	await harness.command("");
	await assert.rejects(readFile(join(root, "b.txt")), { code: "ENOENT" });

	// A real reload: loadRedo reads the persisted step, including the paths that restore changed.
	await harness.start();
	const refsBefore = await countRefs(root);
	harness.queueSelect(() => "Files only");
	await harness.command("redo");

	assert.equal(await readFile(join(root, "b.txt"), "utf8"), "new\n", "redo restores the pre-restore state");
	assert.equal(await countRefs(root), refsBefore + 1, "redo took its own recovery checkpoint");
	const redoEntry = [...harness.entries].reverse().find((entry) => entry.customType === "midnight-checkpoint-redo");
	assert.deepEqual((redoEntry?.data as { steps: unknown[] }).steps, [], "redo consumed the recorded step");
});

test("recover consumes its journal and restores the failed restore's backup", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "a.txt"), "one\n");
	const target = await captureCheckpoint(root, { ...options, scope: ["a.txt"] });
	// A restore that wrote files and then failed leaves its before-restore backup plus a journal.
	await writeFile(join(root, "a.txt"), "pending\n");
	const backup = await captureCheckpoint(root, { ...options, trigger: "before-restore", scope: ["a.txt"] });
	await writeFile(join(root, "a.txt"), "after the failed restore\n");
	await writeFile(
		join(root, ".git", "midnight-restore.json"),
		JSON.stringify({ version: 1, target: target.ref, backup: backup.ref, paths: ["a.txt"], started: Date.now() }),
	);

	const harness = rewindHarness(root, [checkpointEntry(target, "seed-1")]);
	await harness.start();
	// An ordinary rewind is refused while the journal is pending, which proves the journal was loaded.
	await harness.command("");
	assert.ok(
		harness.notices.some((notice) => notice.includes("A failure journal needs")),
		"the incomplete restore blocks an ordinary rewind instead of restoring automatically",
	);
	assert.equal(harness.restores(), 0);
	await harness.command("recover");

	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "pending\n", "recover restored the backup state");
	assert.equal(harness.restores(), 1);
	assert.equal(await readRestoreRecovery(root), null, "recover consumed the journal");
});

test("/rewind across a commit restores the checkpoint and redo returns to the old tip", async (t) => {
	const root = await fixture(t);
	const base = await revParse(root, "HEAD");
	await writeFile(join(root, "a.txt"), "checkpoint edit\n");
	const older = await captureCheckpoint(root, { ...options, scope: ["a.txt"] });
	await writeFile(join(root, "b.txt"), "agent file\n");
	await git(root, ["add", "--", "a.txt", "b.txt"]);
	await git(root, ["commit", "-qm", "agent commit"]);
	const tip = await revParse(root, "HEAD");
	const newer = await captureCheckpoint(root, { ...options, scope: ["a.txt", "b.txt"], previous: older });
	const harness = rewindHarness(root, [checkpointEntry(older, "seed-1"), checkpointEntry(newer, "seed-2")]);
	await harness.start();

	harness.queueSelect(pickBy(older.id.slice(0, 8)), () => "Files only");
	await harness.command("");
	assert.equal(harness.restores(), 1, harness.notices.join("\n"));
	assert.equal(await revParse(root, "HEAD"), base);
	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "checkpoint edit\n");
	await assert.rejects(readFile(join(root, "b.txt")), { code: "ENOENT" });
	assert.ok(harness.notices.some((notice) => notice.includes("1 commit(s) left the branch")));

	harness.queueSelect(() => "Files only");
	await harness.command("redo");
	assert.equal(harness.restores(), 2, harness.notices.join("\n"));
	assert.equal(await revParse(root, "HEAD"), tip, "redo moves the branch forward again");
	assert.equal(await readFile(join(root, "b.txt"), "utf8"), "agent file\n");
	assert.equal((await git(root, ["status", "--porcelain"])).toString("utf8"), "", "the committed state is clean");
});
