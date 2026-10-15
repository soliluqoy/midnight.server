import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ENTRY_TYPE, type EvidenceEvent, type EvidenceRecord } from "../src/evidence/model.ts";
import {
	EvidenceArchiveReader,
	EvidenceBranchReplay,
	EvidenceSessionStore,
	MAX_REPLAY_BRANCH_ENTRIES,
	replayEvidenceBranch,
	UncertainEvidenceAppendError,
} from "../src/evidence/session-store.ts";
import {
	canonicalJson,
	previewRollover,
	projectionDigest,
	type RolloverPreview,
	type ScopedEvent,
	WORKING_SET_ENTRY_TYPE,
	type WorkingSet,
} from "../src/evidence/working-set.ts";

const setId = uuid(1);
const nextSetId = uuid(2);
const rolloverOperation = uuid(101);

function uuid(value: number): string {
	return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

function evidence(id: string, overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
	return {
		id,
		kind: "evidence",
		text: `Observation ${id}`,
		createdAt: "2026-10-14T00:00:00.000Z",
		status: "active",
		refs: [],
		applicability: "historical",
		automatic: false,
		source: { kind: "file", path: "source.ts", sha256: "a".repeat(64), startLine: 1, endLine: 1, quote: "x" },
		...overrides,
	};
}

function claim(id: string, refs: string[]): EvidenceRecord {
	return evidence(id, { kind: "claim", source: undefined, refs, applicability: "current" });
}

function gap(id: string): EvidenceRecord {
	return evidence(id, { kind: "gap", source: undefined });
}

function appendV1(manager: SessionManager, event: EvidenceEvent): string {
	return manager.appendCustomEntry(ENTRY_TYPE, event);
}

function append(manager: SessionManager): (customType: string, data: unknown) => void {
	return (customType, data) => {
		manager.appendCustomEntry(customType, data);
	};
}

function seedLegacy(manager: SessionManager): ReturnType<typeof replayEvidenceBranch> {
	appendV1(manager, { version: 1, action: "add", record: evidence("source") });
	appendV1(manager, { version: 1, action: "add", record: claim("claim", ["source"]) });
	return replayEvidenceBranch(manager);
}

function rollover(
	manager: SessionManager,
	base = replayEvidenceBranch(manager),
	newSetId = setId,
	operationId = rolloverOperation,
): { preview: RolloverPreview; result: ReturnType<typeof replayEvidenceBranch> } {
	assert.ok(base.anchor);
	const preview = previewRollover(base.state, base.anchor, ["claim"], newSetId, operationId);
	const result = new EvidenceSessionStore(manager, append(manager)).commitRollover(base, preview.event, preview.token);
	return { preview, result };
}

function scoped(state: WorkingSet, anchor: string, operationId: string, operation: EvidenceEvent): ScopedEvent {
	return {
		version: 2,
		action: "update",
		operationId,
		setId: state.setId,
		baseAnchor: anchor,
		baseDigest: projectionDigest(state),
		operation,
	};
}

async function workspace(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "midnight-evidence-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

function finish(replay: EvidenceBranchReplay, page = 2048) {
	for (;;) {
		const progress = replay.step(page);
		if (progress.complete) {
			assert.ok(progress.result);
			return progress.result;
		}
	}
}

test("migration, scoped replay, reload, and archive lookup remain bounded and branch-bound", () => {
	const manager = SessionManager.inMemory("store-replay");
	manager.appendSessionInfo("root");
	for (let i = 0; i < 1100; i++) manager.appendSessionInfo(`padding-${i}`);
	const legacy = seedLegacy(manager);
	assert.equal(legacy.mode, "legacy");
	assert.equal(legacy.state.records.length, 2);
	assert.match(legacy.ancestryIdentity, /^evidence:/);
	const { preview, result: migrated } = rollover(manager, legacy);
	assert.equal(migrated.mode, "v2");
	assert.equal(migrated.state.setId, setId);
	assert.ok(migrated.anchor);
	const update = scoped(migrated.state, migrated.anchor, uuid(102), {
		version: 1,
		action: "review",
		id: "source",
		reason: "Source changed",
	});
	const current = new EvidenceSessionStore(manager, append(manager)).commitScoped(migrated, update);
	assert.equal(current.state.records[0].record.review, "Source changed");
	assert.ok(current.state.records[1].record.review);

	const header = manager.getHeader();
	assert.ok(header);
	const reloaded = SessionManager.inMemory(manager.getCwd(), undefined, [
		structuredClone(header),
		...structuredClone(manager.getEntries()),
	]);
	const replayed = replayEvidenceBranch(reloaded);
	assert.equal(replayed.mode, "v2");
	assert.deepEqual(replayed.state, current.state);
	assert.deepEqual(replayed.operationIds, new Set([rolloverOperation, uuid(102)]));
	assert.deepEqual(replayed.setIds, new Set([setId]));

	const reader = new EvidenceArchiveReader();
	const token = reader.begin(reloaded, preview.event.predecessor);
	const pending = reader.read(token, 0, 1);
	assert.equal(pending.complete, false);
	assert.equal(pending.available, false);
	assert.equal(pending.inspected, 2048);
	const first = reader.read(token, 0, 1);
	assert.equal(first.complete, true);
	assert.equal(first.available, true);
	assert.equal(first.total, 2);
	assert.equal(first.records[0].record.id, "source");
	assert.equal(first.nextOffset, 1);
	const second = reader.read(token, first.nextOffset ?? 0, 1);
	assert.equal(second.records[0].record.id, "claim");
	assert.equal(second.nextOffset, null);

	assert.ok(legacy.anchor);
	reloaded.branch(legacy.anchor);
	const stale = reader.read(token);
	assert.equal(stale.available, false);
	assert.equal(stale.issue?.code, "stale_branch");
});

test("archive cursors are LRU-bounded and reject mismatched locators", () => {
	const manager = SessionManager.inMemory("archive-cursors");
	const legacy = seedLegacy(manager);
	assert.ok(legacy.anchor);
	const locator = {
		setId: legacy.state.setId,
		anchor: legacy.anchor,
		digest: projectionDigest(legacy.state),
	};
	const reader = new EvidenceArchiveReader();
	const first = reader.begin(manager, locator);
	const second = reader.begin(manager, locator);
	assert.equal(reader.read(first).available, true, "reading refreshes the first cursor's LRU position");
	reader.begin(manager, locator);
	assert.equal(reader.read(second).issue?.code, "cursor_expired");
	const mismatch = reader.begin(manager, { ...locator, digest: "0".repeat(64) });
	assert.equal(reader.read(mismatch).issue?.code, "locator_mismatch");
	assert.throws(() => reader.read(first, -1), /pagination/);
	assert.throws(() => reader.read(first, 0, 21), /pagination/);
});

test("sibling archives are denied even when their entry IDs are known", () => {
	const manager = SessionManager.inMemory("sibling-denial");
	const legacy = seedLegacy(manager);
	assert.ok(legacy.anchor);
	const common = legacy.anchor;
	const left = rollover(manager, legacy).result;
	assert.equal(left.ancestryIdentity, legacy.ancestryIdentity);
	assert.ok(left.anchor);
	const leftAnchor = left.anchor;
	manager.branch(common);
	manager.appendSessionInfo("right branch");
	assert.equal(replayEvidenceBranch(manager).ancestryIdentity, legacy.ancestryIdentity);

	const denied = finish(new EvidenceBranchReplay(manager, leftAnchor));
	assert.equal(denied.writable, false);
	assert.equal(denied.issue?.code, "missing_ancestor");
	const reader = new EvidenceArchiveReader();
	const token = reader.begin(manager, {
		setId: left.state.setId,
		anchor: leftAnchor,
		digest: projectionDigest(left.state),
	});
	assert.equal(reader.read(token).issue?.code, "missing_ancestor");
});

test("disk reload, fork, branch extraction, and root fallback preserve ancestry identity", async (t) => {
	const root = await workspace(t);
	const sessions = join(root, "sessions");
	const manager = SessionManager.create(join(root, "source-project"), sessions, { id: "source-session" });
	manager.appendMessage({ role: "user", content: "persist", timestamp: Date.now() });
	const legacy = seedLegacy(manager);
	const { result: migrated } = rollover(manager, legacy);
	assert.ok(migrated.anchor);
	const update = scoped(migrated.state, migrated.anchor, uuid(103), {
		version: 1,
		action: "review",
		id: "source",
		reason: "Persisted review",
	});
	const committed = new EvidenceSessionStore(manager, append(manager)).commitScoped(migrated, update);
	const sourcePath = manager.getSessionFile();
	assert.ok(sourcePath);
	const reopened = SessionManager.open(sourcePath);
	const disk = replayEvidenceBranch(reopened);
	assert.equal(canonicalJson(disk.state), canonicalJson(committed.state));
	assert.equal(disk.ancestryIdentity, legacy.ancestryIdentity);

	const fork = SessionManager.forkFrom(sourcePath, join(root, "fork-project"), join(root, "fork-sessions"), {
		id: "fork-session",
	});
	const forked = replayEvidenceBranch(fork);
	assert.notEqual(fork.getSessionId(), manager.getSessionId());
	assert.equal(forked.ancestryIdentity, legacy.ancestryIdentity);
	assert.equal(canonicalJson(forked.state), canonicalJson(committed.state));

	assert.ok(committed.anchor);
	const clonePath = manager.createBranchedSession(committed.anchor);
	assert.ok(clonePath);
	const cloned = replayEvidenceBranch(SessionManager.open(clonePath));
	assert.notEqual(manager.getSessionId(), reopened.getSessionId());
	assert.equal(cloned.ancestryIdentity, legacy.ancestryIdentity);
	assert.equal(canonicalJson(cloned.state), canonicalJson(committed.state));

	const rootOnly = SessionManager.inMemory("root-fallback");
	const rootId = rootOnly.appendSessionInfo("root");
	const rootIdentity = replayEvidenceBranch(rootOnly).ancestryIdentity;
	rootOnly.createBranchedSession(rootId);
	assert.equal(replayEvidenceBranch(rootOnly).ancestryIdentity, rootIdentity);
});

test("branch extraction fails closed when removing a label changes an exact evidence anchor", async (t) => {
	const root = await workspace(t);
	const manager = SessionManager.create(join(root, "project"), join(root, "sessions"), { id: "label-source" });
	manager.appendMessage({ role: "user", content: "persist", timestamp: Date.now() });
	appendV1(manager, { version: 1, action: "add", record: evidence("source") });
	const source = manager.getLeafId();
	assert.ok(source);
	manager.appendLabelChange(source, "migration anchor");
	const base = replayEvidenceBranch(manager);
	assert.ok(base.anchor);
	const preview = previewRollover(base.state, base.anchor, ["source"], setId, rolloverOperation);
	const migrated = new EvidenceSessionStore(manager, append(manager)).commitRollover(
		base,
		preview.event,
		preview.token,
	);
	assert.ok(migrated.anchor);
	const clonePath = manager.createBranchedSession(migrated.anchor);
	assert.ok(clonePath);
	const cloned = replayEvidenceBranch(SessionManager.open(clonePath));
	assert.equal(cloned.mode, "read-only");
	assert.equal(cloned.issue?.code, "invalid_transition");
	assert.match(cloned.issue?.message ?? "", /Stale preview/);
});

test("mixed writers, malformed v2, updates before migration, and duplicate operations fail closed", () => {
	const mixed = SessionManager.inMemory("mixed");
	const legacy = seedLegacy(mixed);
	rollover(mixed, legacy);
	appendV1(mixed, { version: 1, action: "add", record: gap("old-writer") });
	assert.equal(replayEvidenceBranch(mixed).issue?.code, "mixed_writer");

	const malformed = SessionManager.inMemory("malformed");
	seedLegacy(malformed);
	malformed.appendCustomEntry(WORKING_SET_ENTRY_TYPE, { version: 3, action: "rollover" });
	assert.equal(replayEvidenceBranch(malformed).issue?.code, "malformed_v2");

	const premature = SessionManager.inMemory("premature");
	const prematureLegacy = seedLegacy(premature);
	assert.ok(prematureLegacy.anchor);
	premature.appendCustomEntry(WORKING_SET_ENTRY_TYPE, {
		...scoped(prematureLegacy.state, prematureLegacy.anchor, uuid(104), {
			version: 1,
			action: "review",
			id: "source",
			reason: "Too early",
		}),
		setId,
	});
	assert.equal(replayEvidenceBranch(premature).issue?.code, "invalid_transition");

	const duplicate = SessionManager.inMemory("duplicate");
	const duplicateLegacy = seedLegacy(duplicate);
	const first = rollover(duplicate, duplicateLegacy);
	duplicate.appendCustomEntry(WORKING_SET_ENTRY_TYPE, first.preview.event);
	assert.equal(replayEvidenceBranch(duplicate).issue?.code, "duplicate_operation");

	const duplicateSet = SessionManager.inMemory("duplicate-set");
	const firstSet = rollover(duplicateSet, seedLegacy(duplicateSet)).result;
	assert.ok(firstSet.anchor);
	const secondPreview = previewRollover(firstSet.state, firstSet.anchor, ["claim"], nextSetId, uuid(106));
	const secondSet = new EvidenceSessionStore(duplicateSet, append(duplicateSet)).commitRollover(
		firstSet,
		secondPreview.event,
		secondPreview.token,
	);
	assert.ok(secondSet.anchor);
	const reused = previewRollover(secondSet.state, secondSet.anchor, ["claim"], setId, uuid(107));
	duplicateSet.appendCustomEntry(WORKING_SET_ENTRY_TYPE, reused.event);
	assert.equal(replayEvidenceBranch(duplicateSet).issue?.code, "duplicate_set");

	const badLegacy = SessionManager.inMemory("bad-v1");
	badLegacy.appendCustomEntry(ENTRY_TYPE, { version: 1, action: "unknown" });
	const retained = replayEvidenceBranch(badLegacy);
	assert.equal(retained.mode, "legacy");
	assert.equal(retained.writable, true);
	assert.equal(retained.state.invalidEvents, 1);
});

test("replay is resumable, bounded, and invalidated by branch movement", () => {
	const limited = SessionManager.inMemory("scan-limit");
	limited.appendSessionInfo("one");
	limited.appendSessionInfo("two");
	limited.appendSessionInfo("three");
	const cursor = new EvidenceBranchReplay(limited, limited.getLeafId(), 2);
	assert.equal(cursor.step(1).complete, false);
	assert.equal(cursor.step(1).complete, false);
	const exhausted = cursor.step(1);
	assert.equal(exhausted.complete, true);
	assert.equal(exhausted.issue?.code, "scan_limit");

	const moving = SessionManager.inMemory("stale-scan");
	moving.appendSessionInfo("one");
	moving.appendSessionInfo("two");
	const stale = new EvidenceBranchReplay(moving);
	assert.equal(stale.step(1).complete, false);
	moving.appendSessionInfo("changed");
	assert.equal(stale.step(1).issue?.code, "stale_branch");
	assert.throws(() => new EvidenceBranchReplay(moving).step(0), /Replay page/);

	const empty = SessionManager.inMemory("seeded-empty");
	empty.appendSessionInfo("root without evidence");
	const emptyBase = replayEvidenceBranch(empty);
	appendV1(empty, { version: 1, action: "add", record: gap("first") });
	const seeded = finish(new EvidenceBranchReplay(empty, undefined, 2, emptyBase));
	assert.deepEqual(seeded, replayEvidenceBranch(empty), "first legacy event replaces root-derived identity");
	assert.equal(seeded.branchEntries, 2);
	empty.appendSessionInfo("third exceeds full ancestry cap");
	const seededLimit = finish(new EvidenceBranchReplay(empty, undefined, 2, seeded));
	assert.equal(seededLimit.issue?.code, "scan_limit", "incremental seed does not reset the ancestry budget");
	assert.equal(
		finish(new EvidenceBranchReplay(empty, seeded.anchor, 2)).issue?.code,
		"scan_limit",
		"archive authorization and target ancestry share the cap",
	);

	const getEntry = empty.getEntry.bind(empty);
	let reads = 0;
	empty.getEntry = (id) => {
		reads++;
		return getEntry(id);
	};
	const denied = new EvidenceBranchReplay(empty, "unreachable-anchor", 2);
	for (;;) {
		reads = 0;
		const step = denied.step(1);
		assert.equal(step.inspected, reads, "failure paths do not hide extra entry reads");
		if (step.complete) {
			assert.equal(step.issue?.code, "scan_limit");
			break;
		}
	}
});

test("commits reject stale branches, cancellation, and repeated operation IDs", () => {
	const manager = SessionManager.inMemory("commit-preflight");
	const base = seedLegacy(manager);
	assert.ok(base.anchor);
	const preview = previewRollover(base.state, base.anchor, ["claim"], setId, rolloverOperation);
	const store = new EvidenceSessionStore(manager, append(manager));
	assert.throws(
		() => store.commitRollover({ ...base, branchEntries: MAX_REPLAY_BRANCH_ENTRIES }, preview.event, preview.token),
		/ancestry replay limit/,
	);
	manager.appendSessionInfo("interleaving entry");
	assert.throws(() => store.commitRollover(base, preview.event, preview.token), /branch changed/);
	assert.equal(
		manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === WORKING_SET_ENTRY_TYPE)
			.length,
		0,
	);

	const fresh = replayEvidenceBranch(manager);
	assert.ok(fresh.anchor);
	const freshPreview = previewRollover(fresh.state, fresh.anchor, ["claim"], setId, rolloverOperation);
	const controller = new AbortController();
	controller.abort();
	assert.throws(() => store.commitRollover(fresh, freshPreview.event, freshPreview.token, controller.signal), {
		name: "AbortError",
	});
	const committed = store.commitRollover(fresh, freshPreview.event, freshPreview.token);
	assert.ok(committed.operationIds.has(rolloverOperation));
	assert.ok(committed.anchor);
	const repeated = previewRollover(committed.state, committed.anchor, ["claim"], nextSetId, rolloverOperation);
	assert.throws(() => store.commitRollover(committed, repeated.event, repeated.token), /operation .* already exists/);
	const secondPreview = previewRollover(committed.state, committed.anchor, ["claim"], nextSetId, uuid(108));
	const second = store.commitRollover(committed, secondPreview.event, secondPreview.token);
	assert.ok(second.anchor);
	const reusedSet = previewRollover(second.state, second.anchor, ["claim"], setId, uuid(109));
	assert.throws(() => store.commitRollover(second, reusedSet.event, reusedSet.token), /working set .* already exists/);
});

test("append exceptions before and after mutation lock writes until explicit full-branch recovery", () => {
	const beforeManager = SessionManager.inMemory("throw-before");
	const beforeBase = seedLegacy(beforeManager);
	assert.ok(beforeBase.anchor);
	const beforePreview = previewRollover(beforeBase.state, beforeBase.anchor, ["claim"], setId, rolloverOperation);
	let beforeMode: "throw" | "append" = "throw";
	const beforeStore = new EvidenceSessionStore(beforeManager, (customType, data) => {
		if (beforeMode === "throw") throw new Error("before mutation");
		beforeManager.appendCustomEntry(customType, data);
	});
	assert.throws(
		() => beforeStore.commitRollover(beforeBase, beforePreview.event, beforePreview.token),
		(error: unknown) => {
			assert.ok(error instanceof UncertainEvidenceAppendError);
			assert.equal(error.visibleOnActiveAncestry, false);
			return true;
		},
	);
	assert.equal(beforeStore.appendUncertain, true);
	assert.throws(() => beforeStore.commitRollover(beforeBase, beforePreview.event, beforePreview.token), /locked/);
	beforeStore.recover(replayEvidenceBranch(beforeManager));
	beforeMode = "append";
	assert.equal(beforeStore.commitRollover(beforeBase, beforePreview.event, beforePreview.token).mode, "v2");

	const afterManager = SessionManager.inMemory("throw-after");
	const afterBase = seedLegacy(afterManager);
	assert.ok(afterBase.anchor);
	const afterPreview = previewRollover(afterBase.state, afterBase.anchor, ["claim"], setId, rolloverOperation);
	let afterMode: "throw" | "append" = "throw";
	const afterStore = new EvidenceSessionStore(afterManager, (customType, data) => {
		afterManager.appendCustomEntry(customType, data);
		if (afterMode === "throw") throw new Error("after mutation");
	});
	assert.throws(
		() => afterStore.commitRollover(afterBase, afterPreview.event, afterPreview.token),
		(error: unknown) => {
			assert.ok(error instanceof UncertainEvidenceAppendError);
			assert.equal(error.visibleOnActiveAncestry, true);
			return true;
		},
	);
	const reconciled = replayEvidenceBranch(afterManager);
	assert.equal(reconciled.mode, "v2");
	assert.ok(reconciled.operationIds.has(rolloverOperation));
	const archive = finish(new EvidenceBranchReplay(afterManager, afterBase.anchor));
	assert.throws(() => afterStore.recover(archive), /current branch/);
	afterStore.recover(reconciled);
	afterMode = "append";
	assert.ok(reconciled.anchor);
	const update = scoped(reconciled.state, reconciled.anchor, uuid(105), {
		version: 1,
		action: "review",
		id: "source",
		reason: "Recovered",
	});
	assert.equal(afterStore.commitScoped(reconciled, update).state.records[0].record.review, "Recovered");
});

test("unexpected normal append results are uncertain and cannot recover from malformed history", () => {
	const manager = SessionManager.inMemory("wrong-append");
	const base = seedLegacy(manager);
	assert.ok(base.anchor);
	const preview = previewRollover(base.state, base.anchor, ["claim"], setId, rolloverOperation);
	const store = new EvidenceSessionStore(manager, () => {
		manager.appendCustomEntry(WORKING_SET_ENTRY_TYPE, { version: 3, action: "wrong", unserializable: 1n });
	});
	assert.throws(
		() => store.commitRollover(base, preview.event, preview.token),
		(error: unknown) => {
			assert.ok(error instanceof UncertainEvidenceAppendError);
			assert.equal(error.visibleOnActiveAncestry, false);
			return true;
		},
	);
	assert.equal(store.appendUncertain, true);
	const replay = replayEvidenceBranch(manager);
	assert.equal(replay.issue?.code, "malformed_v2");
	assert.throws(() => store.recover(replay), /coherent replay/);
});
