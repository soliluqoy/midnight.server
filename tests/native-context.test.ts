import assert from "node:assert/strict";
import test from "node:test";
import { BudgetTracker, budgetTiers, resolveBudgetPolicy } from "../src/context/budget.ts";
import { applyContextDocument, renderContextDocument } from "../src/context/context-document.ts";
import { createAnnotation, reconstructLiveContextAnnotations, sourceContentHash } from "../src/context/continuity.ts";
import { classifyMirrorToolCall } from "../src/context/mirror-guard.ts";
import { nativeContextOptions } from "../src/context/native.ts";
import { applyOverflowGuard, overflowGuardLimit } from "../src/context/overflow.ts";
import { applyProjection, createProjectionCheckpoint } from "../src/context/projection.ts";

const messages = [
	{ role: "user", content: "Original task" },
	{ role: "assistant", content: "Bulky exploration" },
];

test("native context defaults and legacy environment overrides are portable", () => {
	const defaults = nativeContextOptions({});
	assert.equal(defaults.commandName, "midnight-context");
	assert.equal(defaults.budget?.contextBudget, 150000);
	assert.match(defaults.steeringPath ?? "", /steering[/\\]house-brief\.md$/);
	assert.equal(defaults.oneToolPerTurn, false);
	const custom = nativeContextOptions({
		PI_CLM_BUDGET: "32000",
		PI_CLM_OVERFLOW: "off",
		PI_CLM_NATIVE_COMPACTION: "on",
	});
	assert.equal(custom.budget?.contextBudget, 32000);
	assert.equal(custom.overflow?.mode, "off");
	assert.equal(custom.nativeCompaction, "on");
	assert.throws(() => nativeContextOptions({ PI_CLM_NATIVE_COMPACTION: "maybe" }));
});

test("mirror edits validate current metadata and do not modify the raw transcript", () => {
	const before = structuredClone(messages);
	const snapshot = renderContextDocument(messages, { revision: 2 });
	const changed = snapshot.text.replace("Bulky exploration", "Short summary");
	const applied = applyContextDocument(changed, snapshot, { editingMode: "clm" });
	assert.equal(applied.accepted, true);
	assert.equal(applied.changed, true);
	assert.deepEqual(messages, before);
	assert.equal(
		applyContextDocument(changed.replace("revision=2", "revision=1"), snapshot, { editingMode: "clm" }).accepted,
		false,
	);
	const duplicated = `${changed}\n\n${snapshot.blocks[1].header}\nAnother body`;
	assert.equal(applyContextDocument(duplicated, snapshot, { editingMode: "clm" }).accepted, false);
});

test("new mirror roles are notes rather than provider system instructions", () => {
	const snapshot = renderContextDocument(messages);
	const newHeader = snapshot.blocks[1].header
		.replace(/id=[^ ]+/, "id=new-test")
		.replace("role=assistant", "role=system");
	const applied = applyContextDocument(`${snapshot.text}\n\n${newHeader}\nRemember scope`, snapshot, {
		editingMode: "clm",
	});
	assert.equal(applied.accepted, true);
	assert.notEqual(applied.messages.at(-1)?.role, "system");
});

test("projection retains new raw suffixes and fails closed on a different branch prefix", () => {
	const checkpoint = createProjectionCheckpoint({
		revision: 1,
		sourceMessages: messages,
		projectedMessages: [messages[0]],
		beforeEstimate: 100,
		afterEstimate: 30,
	});
	const suffix = { role: "user", content: "Next task" };
	assert.deepEqual(applyProjection([...messages, suffix], checkpoint).messages, [messages[0], suffix]);
	const other = [{ role: "user", content: "Different branch" }, messages[1]];
	const result = applyProjection(other, checkpoint);
	assert.equal(result.valid, false);
	assert.deepEqual(result.messages, other);
});

test("annotations reconstruct latest branch-local snapshots and retain exact source hashes", () => {
	const annotation = createAnnotation({
		existingIds: [],
		source: {
			sessionId: "test",
			entryId: "entry",
			revision: 1,
			contentHash: sourceContentHash(messages[0]),
			role: "user",
		},
		title: "Task",
		reason: "Retain",
		futureAction: "Recall",
		retention: "continuity",
	});
	const resolved = { ...annotation, resolvedAt: new Date().toISOString(), resolution: "Complete" };
	const branch = [
		{ type: "custom", customType: "live-context-annotation", data: annotation },
		{ type: "custom", customType: "live-context-annotation", data: resolved },
	];
	assert.deepEqual(reconstructLiveContextAnnotations(branch), [resolved]);
	assert.deepEqual(reconstructLiveContextAnnotations(branch.slice(0, 1)), [annotation]);
	assert.notEqual(sourceContentHash(messages[0]), sourceContentHash({ ...messages[0], content: "Edited task" }));
});

test("overflow withholding preserves users and raw tool results, with model-window headroom", () => {
	assert.equal(overflowGuardLimit(150000, 2048, 32000), 25856);
	const tool = { role: "toolResult", toolCallId: "call", toolName: "read", content: "x".repeat(4000) };
	const raw = [messages[0], tool, { role: "user", content: "Continue" }];
	const result = applyOverflowGuard(raw, {
		limit: 400,
		fixedTokens: 0,
		estimate: (rows) => JSON.stringify(rows).length / 4,
	});
	assert.equal(result.withheld.length, 1);
	assert.equal(raw[1].content, tool.content);
	assert.equal(result.messages[0], raw[0]);
	assert.equal(result.messages[2], raw[2]);
});

test("budget reminders re-arm after shrink and ignore stale observations", () => {
	const tiers = budgetTiers(resolveBudgetPolicy(undefined), 10000, 2048);
	const tracker = new BudgetTracker();
	const reading = { budget: 10000, reserve: 2048, estimated: 6000, source: "config" as const };
	assert.equal(tracker.observe(reading, tiers)?.label, "50%");
	assert.equal(tracker.observe(reading, tiers), undefined);
	assert.equal(tracker.observe({ ...reading, estimated: 1000, observed: 9000, observedStale: true }, tiers), undefined);
	assert.equal(tracker.observe(reading, tiers)?.label, "50%");
});

test("mirror reads do not consume write limits; direct writes are recognized", () => {
	const mirror = process.platform === "win32" ? "C:\\temp\\LIVE_CONTEXT.md" : "/tmp/LIVE_CONTEXT.md";
	assert.equal(classifyMirrorToolCall("bash", { command: "rg CTX_TURN LIVE_CONTEXT.md" }, "/tmp", mirror), "read");
	assert.equal(classifyMirrorToolCall("bash", { command: "echo summary > LIVE_CONTEXT.md" }, "/tmp", mirror), "write");
	assert.equal(classifyMirrorToolCall("write", { path: mirror }, "/tmp", mirror), "write");
});
