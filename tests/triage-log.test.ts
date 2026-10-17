import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeLog } from "../src/triage/analysis.ts";
import { createSnapshotStore, prepareLog } from "../src/triage/log.ts";
import { renderTriage, type TriageData } from "../src/triage/result.ts";

const filler = (count: number) => Array.from({ length: count }, (_, index) => `step ${index + 1} completed`);

function tapFailureLog(): string[] {
	const lines = ["TAP version 13", "# Subtest: widget suite", "# tests 12", "# pass 0", "# fail 12"];
	for (let index = 1; index <= 12; index++) lines.push(`ok ${index} - widget state ${index} matches`);
	for (let index = 1; index <= 12; index++) {
		lines.push(`not ok ${index} - widget state ${index} matches`);
		lines.push("  ---");
		lines.push("    duration_ms: 1.234");
		lines.push("    type: 'test'");
		lines.push("    failureType: 'testCodeFailure'");
		lines.push("    error: |-");
		lines.push("      AssertionError [ERR_ASSERTION]: expected 1 to be strictly equal to 2");
		lines.push("        at TestContext.<anonymous> (/tmp/example.test.ts:12:5)");
		lines.push("    code: 'ERR_ASSERTION'");
		lines.push("  ...");
	}
	lines.push("# cancelled 0");
	lines.push("# duration_ms 41.2");
	return lines;
}

test("a TAP log with not ok failures and error detail yields a local recognized-diagnostics gate", () => {
	const analysis = analyzeLog(tapFailureLog());
	assert.equal(analysis.diagnostics.length, 13);
	assert.equal(analysis.diagnosticsOmitted, 0);
	assert.equal(analysis.diagnostics.filter((item) => item.category === "test_failure").length, 12);
	assert.equal(
		analysis.diagnostics.some((item) => item.category === "other"),
		true,
	);
	assert.equal(analysis.localReason, "recognized_diagnostics");
	assert.equal(analysis.localCategory, "mixed");
});

test("a log whose matched lines are all unrecognized keeps the local gate closed", () => {
	const analysis = analyzeLog([
		"error: socket reset",
		"panic: unexpected nil",
		"fatal: bad configuration",
		"exception: null pointer",
		...filler(60),
	]);
	assert.equal(analysis.diagnostics.length, 4);
	assert.equal(analysis.diagnosticsOmitted, 0);
	assert.equal(
		analysis.diagnostics.every((item) => item.category === "other"),
		true,
	);
	assert.equal(analysis.localReason, null);
	assert.equal(analysis.localCategory, null);
});

test("a log with no diagnostic matches keeps the local gate closed", () => {
	const analysis = analyzeLog(filler(60));
	assert.equal(analysis.diagnostics.length, 0);
	assert.equal(analysis.diagnosticsOmitted, 0);
	assert.equal(analysis.localReason, null);
	assert.equal(analysis.localCategory, null);
});

test("dropped diagnostics keep the local gate closed", () => {
	const analysis = analyzeLog(Array.from({ length: 30 }, (_, index) => `not ok ${index + 1} - case ${index + 1}`));
	assert.equal(analysis.diagnostics.length, 24);
	assert.equal(analysis.diagnosticsOmitted, 6);
	assert.equal(
		analysis.diagnostics.every((item) => item.category === "test_failure"),
		true,
	);
	assert.equal(analysis.localReason, null);
	assert.equal(analysis.localCategory, null);
});

test("a truncated diagnostic keeps the local gate closed", () => {
	const analysis = analyzeLog([`not ok 1 - ${"y".repeat(400)}`, ...filler(30)]);
	assert.equal(analysis.diagnostics.length, 1);
	assert.equal(analysis.diagnostics[0].messageTruncated, true);
	assert.equal(analysis.localReason, null);
});

test("snapshot store removes exactly the tracked directories", async () => {
	const root = await mkdtemp(join(tmpdir(), "midnight-snapshot-store-"));
	const first = await mkdtemp(join(root, "midnight-log-triage-"));
	const second = await mkdtemp(join(root, "midnight-log-triage-"));
	const untracked = await mkdtemp(join(root, "midnight-log-triage-"));
	try {
		const store = createSnapshotStore();
		store.track(first);
		store.track(second);
		store.track(first);
		await store.dispose();
		await assert.rejects(stat(first));
		await assert.rejects(stat(second));
		assert.equal((await stat(untracked)).isDirectory(), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("snapshot store disposes each directory once and survives removal failures", async () => {
	const removed: string[] = [];
	const store = createSnapshotStore(async (directory) => {
		removed.push(directory);
		if (directory === "/unremovable") throw new Error("blocked");
	});
	store.track("/snapshot-a");
	store.track("/unremovable");
	store.track("/snapshot-a");
	await assert.doesNotReject(() => store.dispose());
	assert.deepEqual(removed, ["/snapshot-a", "/unremovable"]);
	await store.dispose();
	assert.deepEqual(removed, ["/snapshot-a", "/unremovable"]);
});

test("prepareLog snapshots into the injected root and the store removes that directory", async () => {
	const project = await mkdtemp(join(tmpdir(), "midnight-triage-project-"));
	const snapshotRoot = await mkdtemp(join(tmpdir(), "midnight-triage-root-"));
	await writeFile(join(project, "build.log"), [...filler(60), "error: socket reset"].join("\n"), "utf8");
	const store = createSnapshotStore();
	try {
		const prepared = await prepareLog(project, { path: "build.log" }, "", new AbortController().signal, snapshotRoot);
		assert.equal(dirname(dirname(prepared.snapshot)), snapshotRoot);
		assert.match(basename(dirname(prepared.snapshot)), /^midnight-log-triage-/);
		store.track(dirname(prepared.snapshot));
		await store.dispose();
		await assert.rejects(stat(dirname(prepared.snapshot)));
	} finally {
		await rm(project, { recursive: true, force: true });
		await rm(snapshotRoot, { recursive: true, force: true });
	}
});

const triageFixture = (snapshot: string): TriageData => ({
	version: 2,
	advisory: true,
	warning: "Advisory, not a verified diagnosis.",
	mode: "local",
	reason: "recognized_diagnostics",
	source: "build.log",
	snapshot,
	sha256: "a".repeat(64),
	selectionSha256: "b".repeat(64),
	totalLines: 3,
	scannedRange: { startLine: 1, endLine: 3 },
	selectedRanges: [{ startLine: 1, endLine: 3 }],
	omittedRanges: [],
	selectedLineCount: 3,
	selectedBytes: 40,
	redacted: true,
	diagnostics: [],
	diagnosticsOmitted: 0,
	evidence: "1: error: boom",
	category: "other",
	categorySource: "local",
	confidence: null,
	summary: null,
	summaryTruncated: false,
	exitCode: null,
	errors: [],
	requestAttempts: 0,
	reportedTokens: null,
	reportedCostUsd: null,
	completeUsage: true,
	completeCost: true,
	providerMs: 0,
	totalMs: 3,
});

test("a result states that its local snapshot path is only valid until the session reloads or ends", () => {
	const snapshot = join(tmpdir(), "midnight-log-triage-EXAMPLE", "build.log");
	const rendered = renderTriage(triageFixture(snapshot));
	assert.match(rendered, /valid until this session is reloaded or ends/);
	assert.ok(rendered.includes(snapshot), "the snapshot path itself is still shown for inspection");
});
