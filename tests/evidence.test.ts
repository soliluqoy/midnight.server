import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
	SessionManager,
	type ToolDefinition,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { ParamsSchema, receipt, registerEvidence } from "../src/evidence/index.ts";
import {
	ENTRY_TYPE,
	EvidenceLedger,
	type EvidenceRecord,
	MAX_RECEIPTS,
	MAX_RECORDS,
	ResultSchema,
} from "../src/evidence/model.ts";
import { legacyReviewReason, SemanticLedger, type SemanticRecord } from "../src/evidence/semantics.ts";
import { captureSource, MAX_SOURCE_BYTES, sha256 } from "../src/evidence/source.ts";
import { type TriageData, TriageSchema } from "../src/triage/result.ts";

const hash = "a".repeat(64);
function record(id: string, overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
	return {
		id,
		kind: "evidence",
		text: "Observed source",
		createdAt: new Date().toISOString(),
		status: "active",
		refs: [],
		applicability: "historical",
		automatic: false,
		source: { kind: "file", path: "test.ts", sha256: hash, startLine: 1, endLine: 1, quote: "original" },
		...overrides,
	};
}
const claim = (id: string, refs: string[], overrides: Partial<EvidenceRecord> = {}) =>
	record(id, { kind: "claim", refs, source: undefined, applicability: "current", ...overrides });
const add = (ledger: EvidenceLedger, item: EvidenceRecord) => ledger.apply({ version: 1, action: "add", record: item });

test("v3 review reasons are bounded, explicit, sticky, and do not reinterpret legacy events", () => {
	const ledger = new SemanticLedger();
	const source: SemanticRecord = { ...record("e"), semantics: 3, reviewReasons: [], reviewOverflow: false };
	assert.ok(ledger.apply({ version: 3, action: "add", record: source }));
	assert.equal(ledger.apply({ version: 1, action: "review", id: "e", reason: "ambiguous old prose" }), false);
	assert.deepEqual(legacyReviewReason({ ...source, review: "old explanation" }), {
		code: "legacy_unspecified",
		explanation: "old explanation",
	});
	assert.ok(
		ledger.apply({
			version: 3,
			action: "add",
			record: { ...claim("c", ["e"]), semantics: 3, reviewReasons: [], reviewOverflow: false },
		}),
	);
	assert.ok(
		ledger.apply({
			version: 3,
			action: "add",
			record: {
				...claim("h", ["e"], { applicability: "historical" }),
				semantics: 3,
				reviewReasons: [],
				reviewOverflow: false,
			},
		}),
	);
	for (let i = 0; i < 10; i++)
		assert.ok(
			ledger.apply({
				version: 3,
				action: "review",
				id: "e",
				reason: { code: "source_changed", explanation: `Changed ${i}` },
			}),
		);
	assert.equal(ledger.records.get("e")?.reviewReasons.length, 8);
	assert.equal(ledger.records.get("e")?.reviewOverflow, true);
	assert.equal(ledger.records.get("e")?.review, "Changed 0");
	assert.equal(ledger.records.get("c")?.reviewReasons[0].code, "dependency_review");
	assert.equal(ledger.records.get("h")?.review, undefined);
	const before = structuredClone([...ledger.records]);
	assert.equal(
		ledger.apply({ version: 3, action: "review", id: "e", reason: { code: "restored", explanation: "clear" } }),
		false,
	);
	assert.deepEqual([...ledger.records], before);
	assert.ok(ledger.apply({ version: 3, action: "retract", id: "e", reason: "Withdrawn" }));
	assert.equal(ledger.records.get("h")?.reviewReasons[0].code, "dependency_retracted");
	assert.deepEqual(source.reviewReasons, [], "caller data is not mutated");
});

test("v3 gap concerns survive resolution and reopening; dependency unions stay bounded and acyclic", () => {
	const ledger = new SemanticLedger();
	const events: unknown[] = [];
	const apply = (event: unknown) => {
		assert.ok(ledger.apply(event));
		events.push(event);
	};
	const semantic = (item: EvidenceRecord, concerns?: string[]): SemanticRecord => ({
		...item,
		semantics: 3,
		reviewReasons: [],
		reviewOverflow: false,
		...(concerns ? { concerns } : {}),
	});
	apply({ version: 3, action: "add", record: semantic(record("e")) });
	apply({ version: 3, action: "add", record: semantic(claim("c", ["e"])) });
	apply({
		version: 3,
		action: "add",
		record: semantic(record("g", { kind: "gap", source: undefined, refs: ["c"] }), ["c"]),
	});
	apply({ version: 3, action: "resolve", id: "g", reason: "Observed", resolvedBy: ["e"] });
	assert.deepEqual(ledger.records.get("g")?.concerns, ["c"]);
	assert.deepEqual(ledger.records.get("g")?.resolvedBy, ["e"]);
	assert.deepEqual(ledger.records.get("g")?.refs, ["c", "e"]);
	apply({ version: 3, action: "add", record: semantic(record("e2", { supersedes: "e" })) });
	assert.equal(ledger.records.get("g")?.status, "active");
	assert.deepEqual(
		ledger.records.get("g")?.resolvedBy,
		["e"],
		"old resolution support remains visible until explicitly replaced",
	);
	apply({ version: 3, action: "resolve", id: "g", reason: "Updated observation", resolvedBy: ["e2"] });
	assert.deepEqual(ledger.records.get("g")?.concerns, ["c"]);
	assert.ok(ledger.records.get("g")?.review, "resolving does not clear earlier review");
	const replay = new SemanticLedger();
	for (const event of events) assert.ok(replay.apply(event));
	assert.deepEqual([...replay.records], [...ledger.records]);
	const before = structuredClone([...ledger.records]);
	assert.equal(
		ledger.apply({
			version: 3,
			action: "add",
			record: semantic(record("self", { kind: "gap", source: undefined, refs: ["self"] }), ["self"]),
		}),
		false,
	);
	assert.equal(
		ledger.apply({ version: 3, action: "resolve", id: "g", reason: "Not evidence", resolvedBy: ["c"] }),
		false,
	);
	assert.deepEqual([...ledger.records], before);
});

test("immutable corrections invalidate dependents; old evidence stays recoverable", () => {
	const ledger = new EvidenceLedger();
	const original = record("e1");
	assert.ok(add(ledger, original));
	assert.ok(add(ledger, claim("c1", ["e1"])));
	assert.ok(add(ledger, record("g1", { kind: "gap", source: undefined, refs: ["c1"] })));
	assert.ok(add(ledger, record("e2", { supersedes: "e1", text: "Corrected reading" })));
	assert.equal(original.status, "active");
	assert.equal(ledger.records.get("e1")?.status, "superseded");
	assert.match(ledger.records.get("c1")?.review ?? "", /superseded/);
	assert.ok(ledger.records.get("g1")?.review);
	assert.equal(ledger.records.get("e1")?.source?.kind, "file");
	assert.ok(add(ledger, claim("c2", ["e2"], { supersedes: "c1" })));
	assert.equal(ledger.records.get("c2")?.review, undefined);
	assert.equal(ledger.records.get("c1")?.status, "superseded");
});

test("applicability changes do not falsify historical claims; retractions affect both", () => {
	const ledger = new EvidenceLedger();
	add(ledger, record("e"));
	add(ledger, claim("current", ["e"]));
	add(ledger, claim("history", ["e"], { applicability: "historical" }));
	ledger.apply({ version: 1, action: "review", id: "e", reason: "Source changed" });
	assert.ok(ledger.records.get("current")?.review);
	assert.equal(ledger.records.get("history")?.review, undefined);
	add(ledger, claim("new-history", ["e"], { applicability: "historical" }));
	assert.equal(ledger.records.get("new-history")?.review, undefined);
	ledger.apply({ version: 1, action: "retract", id: "e", reason: "Incorrect observation" });
	assert.ok(ledger.records.get("history")?.review);
	assert.ok(ledger.records.get("new-history")?.review);
});

test("references, supersession, malformed persistence and gap resolution are validated", () => {
	const ledger = new EvidenceLedger();
	assert.equal(ledger.apply({ version: 2 }), false);
	assert.equal(add(ledger, claim("bad", ["missing"])), false);
	assert.equal(add(ledger, claim("empty", [])), false);
	assert.equal(add(ledger, record("source-less", { source: undefined })), false);
	assert.ok(add(ledger, record("e")));
	assert.equal(add(ledger, record("e")), false);
	assert.equal(add(ledger, claim("wrong-kind", ["e"], { supersedes: "e" })), false);
	assert.ok(add(ledger, record("gap", { kind: "gap", source: undefined })));
	assert.equal(ledger.apply({ version: 1, action: "resolve", id: "gap", reason: "Guess", refs: [] }), false);
	assert.ok(ledger.apply({ version: 1, action: "resolve", id: "gap", reason: "Inspected source", refs: ["e"] }));
	assert.equal(ledger.records.get("gap")?.status, "resolved");
	assert.equal(ledger.summary().gaps, 0);
	assert.ok(ledger.apply({ version: 1, action: "retract", id: "e", reason: "Observation was wrong" }));
	assert.equal(ledger.records.get("gap")?.status, "active");
	assert.ok(ledger.records.get("gap")?.review);
	assert.equal(ledger.summary().gaps, 1);
	assert.equal(
		add(ledger, record("gap2", { kind: "gap", source: undefined, refs: ["gap"], supersedes: "gap" })),
		false,
	);
});

// Phase 0 characterization: recovery is deliberately not implemented by these tests.
// Phase 1 must add recovery assertions without weakening rejection/non-mutation guarantees.
test("v1 capacity includes inactive history and rejects corrections without partially replacing records", () => {
	const ledger = new EvidenceLedger();
	assert.ok(add(ledger, record("source")));
	assert.ok(add(ledger, claim("dependent", ["source"])));
	for (let i = ledger.records.size; i < MAX_RECORDS; i++) {
		assert.ok(add(ledger, record(`gap-${i}`, { kind: "gap", source: undefined })));
	}
	const before = structuredClone([...ledger.records]);
	assert.equal(add(ledger, record("replacement", { supersedes: "source" })), false);
	assert.deepEqual([...ledger.records], before);
	assert.equal(ledger.invalidEvents, 1);
	assert.equal(ledger.summary().capacityReached, true);
	assert.ok(ledger.apply({ version: 1, action: "retract", id: "gap-2", reason: "No longer relevant" }));
	assert.equal(ledger.records.size, MAX_RECORDS);
	assert.equal(add(ledger, record("replacement", { supersedes: "source" })), false);
	assert.equal(ledger.records.get("source")?.status, "active");
	assert.equal(ledger.records.get("dependent")?.review, undefined);
	assert.equal(ledger.records.has("replacement"), false);
});

test("v1 resolution replaces concerns, retains review, and only active records accept lifecycle updates", () => {
	const ledger = new EvidenceLedger();
	assert.ok(add(ledger, record("source")));
	assert.ok(add(ledger, claim("concern", ["source"])));
	assert.ok(add(ledger, record("gap", { kind: "gap", source: undefined, refs: ["concern"] })));
	assert.ok(ledger.apply({ version: 1, action: "review", id: "gap", reason: "Prior uncertainty" }));
	assert.ok(ledger.apply({ version: 1, action: "resolve", id: "gap", reason: "Observed", refs: ["source"] }));
	assert.deepEqual(ledger.records.get("gap")?.refs, ["source"]);
	assert.equal(ledger.records.get("gap")?.review, "Prior uncertainty");
	const closed = structuredClone(ledger.records.get("gap"));
	for (const action of ["review", "retract", "resolve"] as const) {
		assert.equal(ledger.apply({ version: 1, action, id: "gap", reason: "Rejected", refs: ["source"] }), false);
	}
	assert.equal(add(ledger, record("replacement-gap", { kind: "gap", source: undefined, supersedes: "gap" })), false);
	assert.deepEqual(ledger.records.get("gap"), closed);
	assert.ok(ledger.apply({ version: 1, action: "review", id: "source", reason: "Source unavailable" }));
	assert.equal(ledger.records.get("gap")?.status, "active");
	assert.match(ledger.records.get("gap")?.review ?? "", /Source unavailable/);
	assert.equal(ledger.apply({ version: 1, action: "resolve", id: "gap", reason: "Stale", refs: ["source"] }), false);
	assert.ok(add(ledger, record("fresh", { supersedes: "source" })));
	assert.equal(ledger.records.get("source")?.status, "superseded");
	assert.equal(ledger.apply({ version: 1, action: "retract", id: "source", reason: "Already inactive" }), false);
	assert.ok(ledger.apply({ version: 1, action: "resolve", id: "gap", reason: "Reassessed", refs: ["fresh"] }));
	assert.equal(ledger.records.get("gap")?.status, "resolved");
	assert.ok(ledger.records.get("gap")?.review, "v1 resolution does not clear the previous review reason");
});

async function workspace(t: TestContext) {
	const cwd = await mkdtemp(join(tmpdir(), "midnight-evidence-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}

test("file evidence retains bounded Unicode excerpts and original byte hashes, rejecting unsafe sources", async (t) => {
	const cwd = await workspace(t);
	await writeFile(join(cwd, "文档 file.ts"), "first\r\n文档 é\r\nthird\n");
	const source = await captureSource(cwd, "文档 file.ts", 2, 2);
	assert.equal(source.kind, "file");
	if (source.kind !== "file") return;
	assert.equal(source.quote, "文档 é");
	assert.equal(source.sha256, sha256("first\r\n文档 é\r\nthird\n"));
	await assert.rejects(captureSource(cwd, "../outside"), /inside/);
	await writeFile(join(cwd, ".env"), "not a real secret");
	await assert.rejects(captureSource(cwd, ".env"), /non-sensitive/);
	await writeFile(join(cwd, "private.pem"), "fixture only");
	await assert.rejects(captureSource(cwd, "private.pem"), /non-sensitive/);
	await assert.rejects(captureSource(cwd, "."), /file up to/);
	await writeFile(join(cwd, "large.txt"), Buffer.alloc(MAX_SOURCE_BYTES + 1));
	await assert.rejects(captureSource(cwd, "large.txt"), /1 MiB/);
	await writeFile(join(cwd, "binary.txt"), Buffer.from([0, 1]));
	await assert.rejects(captureSource(cwd, "binary.txt"), /binary/);
	await writeFile(join(cwd, "invalid.txt"), Buffer.from([0xff]));
	await assert.rejects(captureSource(cwd, "invalid.txt"));
	await writeFile(join(cwd, "long.txt"), "x".repeat(4001));
	await assert.rejects(captureSource(cwd, "long.txt"), /4000/);
	await assert.rejects(captureSource(cwd, "文档 file.ts", 1, 101), /100 lines/);
	await assert.rejects(captureSource(cwd, "文档 file.ts", 10, 11), /beyond/);
	await assert.rejects(captureSource(cwd, "文档 file.ts", 0), /Invalid/);
	const aborted = AbortSignal.abort();
	await assert.rejects(captureSource(cwd, "文档 file.ts", 1, 1, aborted), /abort/i);
});

test("file evidence rejects symlink escapes and sensitive symlink destinations", async (t) => {
	const cwd = await workspace(t);
	const outside = await workspace(t);
	await mkdir(join(cwd, "project"));
	await writeFile(join(outside, "outside.txt"), "outside");
	await writeFile(join(cwd, ".env"), "not a real secret");
	try {
		await symlink(outside, join(cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
		await symlink(cwd, join(cwd, "project", "loop"), process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("Symlink permission unavailable");
		throw error;
	}
	await assert.rejects(captureSource(cwd, "escape/outside.txt"), /symlink target/);
	await assert.rejects(captureSource(cwd, "project/loop/.env"), /non-sensitive/);
});

function harness(cwd: string, manager = SessionManager.inMemory(cwd)) {
	let tool!: ToolDefinition;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const notices: string[] = [];
	const pi = {
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
		appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		mode: "json",
		hasUI: false,
		sessionManager: manager,
		ui: { notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionContext;
	const integration = registerEvidence(pi);
	const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
	emit("session_start");
	const run = async (params: Record<string, unknown>, signal?: AbortSignal) => {
		assert.ok(Value.Check(ParamsSchema, params));
		const result = await tool.execute("ledger-call", params, signal, undefined, ctx as ExtensionToolContext);
		assert.ok(Value.Check(ResultSchema, result.structuredContent));
		assert.deepEqual(result.details, result.structuredContent);
		assert.ok(result.content[0]?.type === "text");
		return result.structuredContent as import("typebox").Static<typeof ResultSchema>;
	};
	const observe = (event: ToolResultEvent) => {
		emit("tool_call", event);
		emit("tool_result", event);
	};
	return { run, emit, observe, manager, handlers, integration, notices, ctx, tool: () => tool };
}

test("frozen v1 events replay deterministically, count malformed entries, and isolate sibling branches", async (t) => {
	const fixture = JSON.parse(await readFile(new URL("./fixtures/evidence-v1.json", import.meta.url), "utf8")) as {
		events: unknown[];
		invalidEvents: unknown[];
	};
	const original = structuredClone(fixture);
	const ledger = new EvidenceLedger();
	for (const event of fixture.events) assert.ok(ledger.apply(event));
	const valid = structuredClone([...ledger.records]);
	for (const event of fixture.invalidEvents) assert.equal(ledger.apply(event), false);
	assert.deepEqual([...ledger.records], valid);
	assert.deepEqual(fixture, original, "replay never mutates persisted input objects");
	assert.equal(ledger.invalidEvents, 3);
	assert.equal(ledger.records.get("legacy-claim")?.review, undefined);
	assert.equal(ledger.records.get("legacy-gap")?.status, "active");
	assert.deepEqual(ledger.records.get("legacy-gap")?.refs, ["legacy-source"]);

	const cwd = await workspace(t);
	const manager = SessionManager.inMemory(cwd);
	for (const event of [...fixture.events, ...fixture.invalidEvents]) manager.appendCustomEntry(ENTRY_TYPE, event);
	const base = manager.getLeafId();
	assert.ok(base);
	const h = harness(cwd, manager);
	const snapshot = await h.run({ action: "list", includeInactive: true });
	assert.deepEqual(snapshot.records, [...ledger.records.values()].reverse());
	assert.equal(snapshot.summary.invalidEvents, 3);
	const left = (await h.run({ action: "add", kind: "gap", text: "Left-only question" })).records[0];
	const leftLeaf = manager.getLeafId();
	assert.ok(leftLeaf);
	manager.branch(base);
	h.emit("session_tree");
	const right = (await h.run({ action: "add", kind: "gap", text: "Right-only question" })).records[0];
	await assert.rejects(h.run({ action: "list", id: left.id }), /not found/);
	manager.branch(leftLeaf);
	h.emit("session_tree");
	await assert.rejects(h.run({ action: "list", id: right.id }), /not found/);
	assert.equal((await h.run({ action: "list", id: left.id })).records[0].id, left.id);
	manager.branch(base);
	const resumed = harness(cwd, manager);
	assert.deepEqual(await resumed.run({ action: "list", includeInactive: true }), snapshot);
});

test("runtime capacity failures persist nothing; retracting retains history and still cannot free a slot", async (t) => {
	const cwd = await workspace(t);
	const manager = SessionManager.inMemory(cwd);
	for (let i = 0; i < MAX_RECORDS; i++) {
		manager.appendCustomEntry(ENTRY_TYPE, {
			version: 1,
			action: "add",
			record: record(`full-${i}`, { kind: "gap", source: undefined }),
		});
	}
	const h = harness(cwd, manager);
	const initialCount = manager.getEntries().length;
	const before = await h.run({ action: "list", id: "full-0" });
	await assert.rejects(h.run({ action: "add", kind: "gap", text: "Replacement", supersedes: "full-0" }), /capacity/);
	assert.equal(manager.getEntries().length, initialCount);
	assert.deepEqual(await h.run({ action: "list", id: "full-0" }), before);
	h.observe(commandEvent(0));
	assert.equal(manager.getEntries().length, initialCount, "passive receipt exhaustion also appends nothing");
	await h.run({ action: "retract", id: "full-1", reason: "No longer relevant" });
	assert.equal(manager.getEntries().length, initialCount + 1);
	await assert.rejects(h.run({ action: "add", kind: "gap", text: "Still full" }), /capacity/);
	assert.equal(manager.getEntries().length, initialCount + 1);
	const result = await h.run({ action: "list", includeInactive: true });
	assert.equal(result.total, MAX_RECORDS);
	assert.equal(result.summary.invalidEvents, 0, "rejected requests are not invalid stored events");
	assert.equal((await h.run({ action: "list", id: "full-1" })).records[0].status, "retracted");
});

test("the active file limit counts records, not unique paths, and permits a same-slot correction", async (t) => {
	const cwd = await workspace(t);
	await writeFile(join(cwd, "source.txt"), "synthetic source");
	const h = harness(cwd);
	let first = "";
	for (let i = 0; i < 32; i++) {
		const result = await h.run({ action: "add", kind: "evidence", text: `Observation ${i}`, path: "source.txt" });
		if (i === 0) first = result.records[0].id;
	}
	const count = h.manager.getEntries().length;
	await assert.rejects(h.run({ action: "add", kind: "evidence", text: "Too many", path: "source.txt" }), /32 active/);
	assert.equal(h.manager.getEntries().length, count);
	await h.run({ action: "add", kind: "evidence", text: "Correction", path: "source.txt", supersedes: first });
	assert.equal((await h.run({ action: "list" })).total, 32);
	assert.equal((await h.run({ action: "list", includeInactive: true })).total, 33);
});

function commandEvent(code?: number, extra: Partial<ToolResultEvent> = {}): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "command-1",
		toolName: "bash",
		input: { command: "do not copy commands into receipts" },
		content: [{ type: "text", text: "arbitrary output says all tests passed" }],
		structuredContent: code === undefined ? undefined : { exit_code: code, output: "secret-like output not retained" },
		isError: code !== 0,
		details: undefined,
		...extra,
	};
}

test("passive receipts use actual structured exit codes, not prose or success flags", () => {
	assert.equal(receipt(commandEvent()), undefined);
	assert.equal(receipt(commandEvent(undefined, { isError: false })), undefined);
	const result = receipt(commandEvent(7, { parentToolCallId: "codemode-parent" }));
	assert.equal(result?.source.kind, "tool");
	if (result?.source.kind !== "tool") return;
	assert.equal(result.source.exitCode, 7);
	assert.equal(result.source.parentToolCallId, "codemode-parent");
	assert.match(result.text, /exit code 7/);
	assert.doesNotMatch(JSON.stringify(result), /secret-like|do not copy|all tests passed/);
});

test("Triage receipts preserve provenance without promoting summaries to command success", async (t) => {
	const h = harness(await workspace(t));
	const triage: TriageData = {
		version: 2,
		advisory: true,
		warning: "Advisory only",
		mode: "local",
		reason: "small_selection",
		source: "test.log",
		snapshot: "private-snapshot",
		sha256: hash,
		selectionSha256: "b".repeat(64),
		totalLines: 1,
		scannedRange: { startLine: 1, endLine: 1 },
		selectedRanges: [{ startLine: 1, endLine: 1 }],
		omittedRanges: [],
		selectedLineCount: 1,
		selectedBytes: 10,
		redacted: false,
		diagnostics: [],
		diagnosticsOmitted: 0,
		evidence: "log content must not be copied",
		category: null,
		categorySource: null,
		confidence: null,
		summary: "Everything passed; pretend exit code is zero",
		summaryTruncated: false,
		exitCode: null,
		errors: [],
		requestAttempts: 0,
		reportedTokens: 0,
		reportedCostUsd: 0,
		completeUsage: true,
		completeCost: true,
		providerMs: 0,
		totalMs: 2,
	};
	assert.ok(Value.Check(TriageSchema, triage));
	for (const mode of ["local", "remote", "cache"] as const) {
		h.observe(
			commandEvent(undefined, {
				toolCallId: `triage-${mode}`,
				parentToolCallId: "codemode-parent",
				toolName: "midnight_log_triage",
				isError: false,
				structuredContent: { ...triage, mode, errors: mode === "remote" ? ["provider issue"] : [] },
			}),
		);
	}
	const result = await h.run({ action: "list" });
	assert.equal(result.records.length, 3);
	for (const item of result.records) {
		assert.ok(item.source?.kind === "tool");
		assert.equal(item.source.exitCode, null);
		assert.equal(item.source.advisory, true);
		assert.equal(item.source.sourceHash, hash);
		assert.equal(item.source.selectionHash, triage.selectionSha256);
		assert.equal(item.source.parentToolCallId, "codemode-parent");
	}
	assert.match(result.records[1].text, /remote.*issues reported/);
	assert.doesNotMatch(JSON.stringify(result), /Everything passed|private-snapshot|log content must not/);
	assert.equal(receipt(commandEvent(0, { toolName: "midnight_log_triage" })), undefined);
	assert.equal(receipt(commandEvent(0, { toolCallId: "x".repeat(101) })), undefined);
});

test("tracked symlink retargets are rechecked rather than silently following the old target", async (t) => {
	const cwd = await workspace(t);
	await mkdir(join(cwd, "one"));
	await mkdir(join(cwd, "two"));
	await writeFile(join(cwd, "one", "source.txt"), "first");
	await writeFile(join(cwd, "two", "source.txt"), "second");
	const alias = join(cwd, "alias");
	try {
		await symlink(join(cwd, "one"), alias, process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("Symlink permission unavailable");
		throw error;
	}
	const h = harness(cwd);
	const item = (await h.run({ action: "add", kind: "evidence", text: "First", path: "alias/source.txt" })).records[0];
	await rm(alias);
	await symlink(join(cwd, "two"), alias, process.platform === "win32" ? "junction" : "dir");
	await h.emit("session_compact");
	assert.ok((await h.run({ action: "list", id: item.id })).records[0].review);
});

test("native receipts persist on the active branch, nested calls work, and no context hooks are installed", async (t) => {
	const cwd = await workspace(t);
	const h = harness(cwd);
	assert.equal(h.tool().executionMode, "sequential");
	assert.equal(h.handlers.has("context"), false);
	assert.equal(h.handlers.has("before_agent_start"), false);
	const base = h.manager.appendCustomEntry("test-base", {});
	h.observe(commandEvent(0, { parentToolCallId: "codemode" }));
	const first = await h.run({ action: "list" });
	assert.equal(first.records.length, 1);
	assert.equal(first.records[0].automatic, true);
	const branch = h.manager.getLeafId();
	assert.ok(branch);
	h.manager.branch(base);
	h.emit("session_tree");
	assert.equal((await h.run({ action: "list" })).records.length, 0);
	h.manager.branch(branch);
	h.emit("session_tree");
	assert.equal((await h.run({ action: "list" })).records[0].id, first.records[0].id);
	const resumed = harness(cwd, h.manager);
	assert.equal((await resumed.run({ action: "list" })).records[0].id, first.records[0].id);
});

test("current claims become review-only after mutations, reloads, and source changes; originals persist", async (t) => {
	const cwd = await workspace(t);
	await writeFile(join(cwd, "test.ts"), "original\n");
	const h = harness(cwd);
	const e = (await h.run({ action: "add", kind: "evidence", text: "The source says original", path: "test.ts" }))
		.records[0];
	const c = (await h.run({ action: "add", kind: "claim", text: "Current source is original", refs: [e.id] }))
		.records[0];
	const historic = (
		await h.run({
			action: "add",
			kind: "claim",
			text: "Source was original",
			refs: [e.id],
			applicability: "historical",
		})
	).records[0];
	h.observe(commandEvent(undefined, { toolName: "edit", toolCallId: "edit", isError: true }));
	assert.ok((await h.run({ action: "list", id: c.id })).records[0].review);
	assert.equal((await h.run({ action: "list", id: historic.id })).records[0].review, undefined);
	await writeFile(join(cwd, "test.ts"), "changed\n");
	await h.emit("agent_end");
	const old = (await h.run({ action: "list", id: e.id })).records[0];
	assert.ok(old.review);
	assert.equal(old.source?.kind === "file" && old.source.quote, "original");
	assert.equal((await h.run({ action: "list", id: historic.id })).records[0].review, undefined);
	const corrected = (
		await h.run({ action: "add", kind: "evidence", text: "Source now changed", path: "test.ts", supersedes: e.id })
	).records[0];
	const newClaim = (
		await h.run({
			action: "add",
			kind: "claim",
			text: "Current source changed",
			refs: [corrected.id],
			supersedes: c.id,
		})
	).records[0];
	assert.equal(newClaim.review, undefined);
	h.emit("session_start");
	assert.ok((await h.run({ action: "list", id: newClaim.id })).records[0].review);
	const stored = h.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE);
	assert.ok(stored.length > 5);
});

test("missing files are unknown, never clean; checks do not automatically clear review", async (t) => {
	const cwd = await workspace(t);
	await writeFile(join(cwd, "source.txt"), "exact");
	const h = harness(cwd);
	const item = (await h.run({ action: "add", kind: "evidence", text: "Observed", path: "source.txt" })).records[0];
	await rm(join(cwd, "source.txt"));
	await h.run({ action: "check" });
	assert.ok((await h.run({ action: "list", id: item.id })).records[0].review);
	await writeFile(join(cwd, "source.txt"), "exact");
	await h.run({ action: "check" });
	assert.ok((await h.run({ action: "list", id: item.id })).records[0].review);
});

test("bounded pagination, receipt cap and command surface work without TUI", async (t) => {
	const h = harness(await workspace(t));
	for (let i = 0; i < MAX_RECEIPTS + 1; i++) h.observe(commandEvent(0, { toolCallId: `call-${i}` }));
	const result = await h.run({ action: "list", limit: 2 });
	assert.equal(result.records.length, 2);
	assert.equal(result.nextOffset, 2);
	assert.equal(result.total, MAX_RECEIPTS);
	assert.equal(result.summary.capacityReached, true);
	const next = await h.run({ action: "list", offset: 2, limit: 2 });
	assert.notEqual(next.records[0].id, result.records[0].id);
	await h.integration.command("status", h.ctx);
	assert.match(h.notices[0], /Capture limit/);
	await assert.rejects(h.run({ action: "list", id: "missing" }), /not found/);
	assert.equal(Value.Check(ParamsSchema, { action: "list", limit: 21 }), false);
});

test("concurrent codemode updates serialize, errors do not persist, cancellation discards queued work", async (t) => {
	const h = harness(await workspace(t));
	const [one, two] = await Promise.all([
		h.run({ action: "add", kind: "gap", text: "First decision-changing question?" }),
		h.run({ action: "add", kind: "gap", text: "Second question?" }),
	]);
	assert.notEqual(one.records[0].id, two.records[0].id);
	assert.equal((await h.run({ action: "list" })).total, 2);
	const count = h.manager.getEntries().length;
	await assert.rejects(h.run({ action: "add", kind: "claim", text: "Unsupported", refs: ["missing"] }), /Invalid/);
	assert.equal(h.manager.getEntries().length, count);
	await assert.rejects(h.run({ action: "add", kind: "gap", text: "Cancelled" }, AbortSignal.abort()), /abort/i);
	const late = h.run({ action: "add", kind: "gap", text: "Late" });
	h.emit("session_shutdown");
	await assert.rejects(late, /abort|changed/i);
	h.emit("session_start");
	assert.equal((await h.run({ action: "list" })).total, 2);
	h.emit("tool_call", commandEvent(0));
	h.emit("session_start");
	h.emit("tool_result", commandEvent(0));
	assert.equal((await h.run({ action: "list" })).total, 2, "late observed calls are discarded");
});
