import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { formatEvidenceResult } from "../src/evidence/format-result.ts";
import { ENTRY_TYPE, type EvidenceSummary } from "../src/evidence/model.ts";
import { registerEvidence } from "../src/evidence/register.ts";
import {
	type EvidenceLiveResultV2,
	EvidenceResultV2Schema,
	PublicEvidenceResultSchema,
} from "../src/evidence/result-v2.ts";
import type { SemanticRecord } from "../src/evidence/semantics.ts";
import { replayEvidenceBranch } from "../src/evidence/session-store.ts";
import { projectionDigest, SEMANTIC_ENTRY_TYPE } from "../src/evidence/working-set.ts";

function harness(cwd = "registration", initialManager = SessionManager.inMemory(cwd)) {
	let manager = initialManager;
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	let tool!: ToolDefinition;
	const notifications: string[] = [];
	const confirmations: string[] = [];
	let confirm: () => Promise<boolean> = async () => false;
	const published: EvidenceSummary[] = [];
	let append: (type: string, data: unknown) => void = (type, data) => {
		manager.appendCustomEntry(type, data);
	};
	const pi = {
		on(name: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			handlers.set(name, handler);
		},
		appendEntry(type: string, data: unknown) {
			append(type, data);
		},
		registerTool(value: ToolDefinition) {
			tool = value;
		},
	} as unknown as ExtensionAPI;
	const bridge = registerEvidence(pi, (summary) => published.push(summary));
	const context = () =>
		({
			cwd: manager.getCwd(),
			sessionManager: manager,
			mode: "tui",
			hasUI: true,
			isIdle: () => true,
			ui: {
				notify: (text: string) => notifications.push(text),
				confirm: async (_title: string, message: string) => {
					confirmations.push(message);
					return confirm();
				},
			},
		}) as unknown as ExtensionToolContext;
	return {
		bridge,
		notifications,
		confirmations,
		setConfirm(fn: typeof confirm) {
			confirm = fn;
		},
		published,
		context,
		get manager() {
			return manager;
		},
		get tool() {
			return tool;
		},
		setAppend(fn: typeof append) {
			append = fn;
		},
		replace() {
			manager = SessionManager.inMemory("replacement");
		},
		async event(name: string, event: unknown = {}, ctx = context()) {
			await handlers.get(name)?.(event as never, ctx);
		},
		async execute(params: unknown, signal?: AbortSignal, ctx = context()) {
			const result = await tool.execute("call", params, signal, undefined, ctx);
			assert.ok(Value.Check(EvidenceResultV2Schema, result.details));
			return { ...result, details: result.details as EvidenceLiveResultV2 };
		},
	};
}

test("fresh-session v3 is live across source checks, relationships, rollover, archive and replay", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "midnight-v3-live-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "source.txt"), "original\n");
	const h = harness(cwd, SessionManager.create(cwd, join(cwd, "sessions")));
	await h.event("session_start", { type: "session_start", reason: "new" });
	const initial = await h.execute({ action: "list" });
	assert.equal(initial.details.version, 3);
	assert.equal(initial.details.mode, "v3");
	h.manager.appendMessage({ role: "user", content: "Start investigation", timestamp: Date.now() });
	const source = await h.execute({ action: "add", kind: "evidence", text: "Observed", path: "source.txt" });
	const sourceId = source.details.records[0].record.id;
	const claim = await h.execute({ action: "add", kind: "claim", text: "Interpretation", refs: [sourceId] });
	const claimId = claim.details.records[0].record.id;
	const cleanAuditLeaf = h.manager.getLeafId();
	const cleanAudit = await h.tool.execute(
		"audit-clean",
		{ action: "audit", selected: [claimId] },
		undefined,
		undefined,
		h.context(),
	);
	assert.ok(Value.Check(PublicEvidenceResultSchema, cleanAudit.details));
	assert.equal(cleanAudit.details.action, "audit");
	if (cleanAudit.details.action === "audit") {
		assert.equal(cleanAudit.details.total, 0);
		assert.equal(cleanAudit.details.filesChecked, 1);
		assert.match(cleanAudit.details.warning, /not truth verification/);
	}
	assert.equal(h.manager.getLeafId(), cleanAuditLeaf);
	const gap = await h.execute({ action: "add", kind: "gap", text: "Question", concerns: [claimId] });
	const gapId = gap.details.records[0].record.id;
	await assert.rejects(
		h.execute({ action: "add", kind: "gap", text: "Ambiguous", concerns: [], refs: [] }),
		/not both/,
	);
	const resolved = await h.execute({ action: "resolve", id: gapId, reason: "Observed", resolvedBy: [sourceId] });
	assert.deepEqual((resolved.details.records[0].record as SemanticRecord).concerns, [claimId]);
	await writeFile(join(cwd, "source.txt"), "changed\n");
	await h.event("agent_end");
	await rm(join(cwd, "source.txt"));
	await h.event("session_compact");
	const checked = await h.execute({ action: "list", id: sourceId });
	assert.deepEqual(
		(checked.details.records[0].record as SemanticRecord).reviewReasons.map((r) => r.code),
		["source_changed", "source_unavailable"],
	);
	await writeFile(join(cwd, "source.txt"), "original\n");
	await h.execute({ action: "check" });
	await h.event("session_start", { type: "session_start", reason: "reload" });
	await h.event("session_tree", { type: "session_tree" });
	const reviewedClaim = (await h.execute({ action: "list", id: claimId })).details.records[0].record as SemanticRecord;
	assert.ok(reviewedClaim.reviewReasons.some((r) => r.code === "session_reloaded"));
	assert.ok(reviewedClaim.reviewReasons.some((r) => r.code === "branch_changed"));
	const reopened = (await h.execute({ action: "list", id: gapId })).details.records[0].record as SemanticRecord;
	assert.equal(reopened.status, "active");
	assert.deepEqual(reopened.concerns, [claimId]);
	assert.deepEqual(reopened.resolvedBy, [sourceId]);
	const preview = await h.execute({ action: "preview", selected: [gapId] });
	assert.ok(preview.details.preview);
	assert.equal(preview.details.preview.carried, 3, "closure preserves both concern and resolution support");
	const { token, predecessor } = preview.details.preview;
	h.setConfirm(async () => true);
	await h.bridge.command(`commit ${token}`, h.context());
	const carried = (await h.execute({ action: "list", id: gapId })).details.records[0].record;
	assert.deepEqual(carried, reopened);
	const archived = await h.tool.execute(
		"archive",
		{ action: "archive", locator: predecessor },
		undefined,
		undefined,
		h.context(),
	);
	assert.ok(Value.Check(EvidenceResultV2Schema, archived.details));
	assert.equal(archived.details.version, 3);
	assert.equal(archived.details.action, "archive");
	assert.match(formatEvidenceResult(archived.details) ?? "", /historical/);
	const cold = replayEvidenceBranch(h.manager);
	assert.equal(cold.mode, "v3");
	assert.equal(cold.state.semantics, 3);
	assert.deepEqual(cold.state.records.find(({ record }) => record.id === gapId)?.record, reopened);
	const auditLeaf = h.manager.getLeafId();
	const audit = await h.tool.execute(
		"nested/audit",
		{ action: "audit", selected: [claimId] },
		undefined,
		undefined,
		h.context(),
	);
	assert.ok(Value.Check(PublicEvidenceResultSchema, audit.structuredContent));
	assert.deepEqual(audit.details, audit.structuredContent);
	assert.equal(h.manager.getLeafId(), auditLeaf);
	assert.ok(audit.structuredContent && audit.structuredContent.action === "audit");
	if (audit.structuredContent.action === "audit") {
		assert.equal(audit.structuredContent.legacyRelationships, false);
		assert.ok(audit.structuredContent.findings.some((f) => f.code === "open_concern"));
		assert.match(formatEvidenceResult(audit.details) ?? "", /advisory audit.*not verified/);
	}
	const digest = projectionDigest(cold.state);
	assert.equal(projectionDigest(replayEvidenceBranch(h.manager).state), digest);
	// Pi flushes persistent sessions after an assistant message; these are synthetic, no provider call.
	h.manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Recorded" }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const path = h.manager.getSessionFile();
	assert.ok(path);
	assert.equal(projectionDigest(replayEvidenceBranch(SessionManager.open(path)).state), digest);
	const fork = SessionManager.forkFrom(path, cwd, join(cwd, "forks"));
	assert.equal(replayEvidenceBranch(fork).mode, "v3");
	assert.equal(projectionDigest(replayEvidenceBranch(fork).state), digest);
	assert.ok(
		h.manager
			.getBranch()
			.filter((e) => e.type === "custom")
			.every((e) => e.customType === SEMANTIC_ENTRY_TYPE),
	);
	// v2 writes must not enter a v3 ancestry, even if structurally valid v2 events.
	h.manager.appendCustomEntry("midnight-evidence-v2", {
		version: 2,
		action: "update",
		operationId: "11111111-1111-1111-1111-111111111111",
		setId: cold.state.setId,
		baseAnchor: cold.anchor,
		baseDigest: digest,
		operation: { version: 1, action: "review", id: sourceId, reason: "Old writer" },
	});
	assert.equal(replayEvidenceBranch(h.manager).writable, false);
	await h.event("session_shutdown");
});

test("only explicit new-session startup initializes semantics; initialization failures do not retry", async () => {
	for (const reason of ["startup", "reload", "resume", "fork"] as const) {
		const h = harness();
		await h.event("session_start", { type: "session_start", reason });
		assert.equal(h.manager.getBranch().length, 0);
		await assert.rejects(
			h.execute({ action: "add", kind: "gap", text: "Not upgraded", concerns: [] }),
			/new v3 session/,
		);
		assert.equal((await h.execute({ action: "add", kind: "gap", text: "Legacy" })).details.version, 2);
		await h.event("session_shutdown");
	}
	const h = harness();
	let attempts = 0;
	h.setAppend((type, data) => {
		attempts++;
		h.manager.appendCustomEntry(type, data);
		throw new Error("uncertain initialization");
	});
	await h.event("session_start", { type: "session_start", reason: "new" });
	const locked = await h.execute({ action: "list" });
	assert.equal(locked.details.appendUncertain, true);
	assert.equal(locked.details.mode, "v3");
	await assert.rejects(h.execute({ action: "add", kind: "gap", text: "Locked" }), /locked/);
	assert.equal(attempts, 1);
	h.setConfirm(async () => true);
	await h.bridge.command("recover", h.context());
	assert.equal(attempts, 1);
	assert.equal((await h.execute({ action: "list" })).details.writable, true);
	await h.event("session_shutdown");
	const failed = harness();
	let failedAttempts = 0;
	failed.setAppend(() => {
		failedAttempts++;
		throw new Error("not visible");
	});
	await failed.event("session_start", { type: "session_start", reason: "new" });
	failed.setConfirm(async () => true);
	await failed.bridge.command("recover", failed.context());
	assert.match(failed.notifications.at(-1) ?? "", /will not retry/);
	await failed.event("session_tree", { type: "session_tree" });
	await assert.rejects(failed.execute({ action: "add", kind: "gap", text: "No downgrade" }));
	assert.equal(failedAttempts, 1);
	assert.equal((await failed.execute({ action: "list" })).details.writable, false);
	await failed.event("session_shutdown");
});

test("live registration uses queued v2 results and preserves v1 writes without model commit", async () => {
	const h = harness();
	await h.event("session_start");
	assert.equal(h.tool.name, "midnight_evidence");
	assert.equal(h.tool.outputSchema, PublicEvidenceResultSchema);
	assert.equal(Value.Check(h.tool.parameters, { action: "preview" }), false);
	assert.equal(Value.Check(h.tool.parameters, { action: "commit" }), false);
	const added = await h.execute({ action: "add", kind: "gap", text: "Open question" });
	assert.ok(Value.Check(EvidenceResultV2Schema, added.details));
	assert.equal(added.details.version, 2);
	assert.equal(added.details.mode, "legacy");
	assert.equal(added.details.committed, true);
	assert.equal((added.content[0] as { text: string }).text, JSON.stringify(added.details));
	assert.deepEqual(added.structuredContent, added.details);
	assert.equal(h.manager.getLeafEntry()?.type, "custom");
	assert.ok(
		h.manager
			.getBranch()
			.filter((e) => e.type === "custom")
			.every((e) => e.customType === ENTRY_TYPE),
	);
	assert.equal(h.bridge.summary().gaps, 1);
	await h.bridge.command("show", h.context());
	assert.match(h.notifications.at(-1) ?? "", /Open question/);
	await h.bridge.command("rollover", h.context());
	assert.match(h.notifications.at(-1) ?? "", /status\|check\|show/);
	await h.event("session_shutdown");
	await assert.rejects(h.execute({ action: "list" }), /session changed/);
});

test("registered passive writes share the FIFO and source checks/navigation run through lifecycle hooks", async () => {
	const h = harness();
	await h.event("session_start");
	await h.event("tool_call", { toolCallId: "shell", toolName: "bash" });
	const passive = h.event("tool_result", {
		type: "tool_result",
		toolCallId: "shell",
		toolName: "bash",
		input: {},
		content: [],
		details: undefined,
		structuredContent: { exit_code: 0 },
		isError: false,
	});
	const listed = await h.execute({ action: "list" });
	await passive;
	const source = listed.details.records[0].record;
	assert.equal(source.source?.kind, "tool");
	assert.equal(source.automatic, true);
	const claim = await h.execute({
		action: "add",
		kind: "claim",
		text: "Current interpretation",
		refs: [source.id],
		applicability: "current",
	});
	assert.equal(claim.details.records[0].record.review, undefined);
	const leaf = h.manager.getLeafId();
	assert.ok(leaf);
	await h.event("session_tree");
	const reviewed = await h.execute({ action: "list", id: claim.details.records[0].record.id });
	assert.match(reviewed.details.records[0].record.review ?? "", /Session loaded or branch changed/);
	await h.event("agent_end");
	await h.event("session_compact");
	assert.equal(h.bridge.summary().review, 1);
	h.manager.branch(leaf);
	await h.event("session_tree");
	assert.equal(h.bridge.summary().review, 1, "returning to seen descendant re-applies navigation review");
	await h.event("session_shutdown");
});

test("registered tool preserves post-append cancellation and uncertain append locks across navigation", async () => {
	const h = harness();
	await h.event("session_start");
	const controller = new AbortController();
	h.setAppend((type, data) => {
		h.manager.appendCustomEntry(type, data);
		controller.abort();
	});
	const result = await h.execute(
		{ action: "add", kind: "gap", text: "Committed before cancellation" },
		controller.signal,
	);
	assert.equal(result.details.committed, true);
	assert.equal(result.details.cancelledAfterAppend, true);
	h.setAppend((type, data) => {
		h.manager.appendCustomEntry(type, data);
		throw new Error("append uncertain");
	});
	await assert.rejects(h.execute({ action: "add", kind: "gap", text: "Uncertain" }));
	await h.event("session_tree");
	const locked = await h.execute({ action: "list" });
	assert.equal(locked.details.appendUncertain, true);
	assert.equal(locked.details.writable, false);
	await assert.rejects(h.execute({ action: "add", kind: "gap", text: "No automatic retry" }), /locked/);
	await h.event("session_shutdown");
});

test("registered source checks preserve review after restore and refuse malformed history", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "midnight-evidence-registration-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "source.txt"), "original\n");
	const h = harness(cwd);
	await h.event("session_start");
	const source = await h.execute({ action: "add", kind: "evidence", text: "Source observation", path: "source.txt" });
	await writeFile(join(cwd, "source.txt"), "changed\n");
	await h.event("agent_end");
	assert.equal(h.bridge.summary().review, 1);
	await writeFile(join(cwd, "source.txt"), "original\n");
	await h.bridge.check(h.context());
	const reviewed = await h.execute({ action: "list", id: source.details.records[0].record.id });
	assert.ok(reviewed.details.records[0].record.review);
	h.manager.appendCustomEntry("midnight-evidence-v2", { version: 99 });
	const leaf = h.manager.getLeafId();
	await h.event("session_tree");
	assert.match(h.bridge.summary().unavailable ?? "", /read-only/);
	const result = await h.execute({ action: "list" });
	assert.equal(result.details.writable, false);
	await assert.rejects(h.execute({ action: "add", kind: "gap", text: "No write" }), /read-only/);
	assert.equal(h.manager.getLeafId(), leaf);
	await h.bridge.command("status", h.context());
	assert.match(h.notifications.at(-1) ?? "", /read-only/);
	await h.event("agent_end");
	assert.match(h.bridge.summary().unavailable ?? "", /unavailable/);
	await h.event("session_shutdown");
});

test("navigation cancellation reports a committed prefix rather than a completed check", async () => {
	const h = harness();
	await h.event("session_start");
	await h.event("tool_call", { toolCallId: "shell", toolName: "bash" });
	await h.event("tool_result", {
		type: "tool_result",
		toolCallId: "shell",
		toolName: "bash",
		input: {},
		content: [],
		details: undefined,
		structuredContent: { exit_code: 0 },
		isError: false,
	});
	const result = await h.execute({ action: "list" });
	for (let i = 0; i < 2; i++)
		await h.execute({ action: "add", kind: "claim", text: `Claim ${i}`, refs: [result.details.records[0].record.id] });
	const controller = new AbortController();
	h.setAppend((type, data) => {
		h.manager.appendCustomEntry(type, data);
		controller.abort();
	});
	await h.event("session_tree", {}, { ...h.context(), signal: controller.signal });
	assert.match(h.bridge.summary().unavailable ?? "", /unavailable/);
	h.setAppend((type, data) => {
		h.manager.appendCustomEntry(type, data);
	});
	const listed = await h.execute({ action: "list" });
	assert.equal(listed.details.summary.review, 2, "remaining review is completed on the next operation");
	await h.event("session_shutdown");
});

test("capacity recovery requires confirmed command; model gets preview/archive but no commit or recover", async () => {
	const h = harness();
	for (let i = 0; i < 512; i++)
		h.manager.appendCustomEntry(ENTRY_TYPE, {
			version: 1,
			action: "add",
			record: {
				id: `g${i}`,
				kind: "gap",
				text: `Question ${i}`,
				createdAt: "2026-10-14T00:00:00.000Z",
				status: "active",
				refs: [],
				applicability: "historical",
				automatic: false,
			},
		});
	await h.event("session_start");
	await assert.rejects(h.execute({ action: "add", kind: "gap", text: "At capacity" }), /capacity/);
	assert.equal(Value.Check(h.tool.parameters, { action: "recover" }), false);
	assert.equal(Value.Check(h.tool.parameters, { action: "commit", token: "a".repeat(64) }), false);
	const preview = await h.execute({ action: "preview", selected: ["g0"] });
	assert.ok(preview.details.preview);
	const { token, predecessor } = preview.details.preview;
	assert.equal(preview.details.preview.omitted.total, 511);
	const leaf = h.manager.getLeafId();
	await h.bridge.command(`commit ${token}`, h.context());
	assert.equal(h.manager.getLeafId(), leaf, "declining is not consent");
	assert.match(h.confirmations[0], /511 active records omitted/);
	assert.match(h.confirmations[0], /older\/v1/);
	h.setConfirm(async () => true);
	await h.bridge.command(`commit ${token}`, { ...h.context(), isIdle: () => false });
	assert.equal(h.manager.getLeafId(), leaf, "busy sessions cannot open confirmation");
	await h.bridge.command(`commit ${token}`, { ...h.context(), mode: "json" });
	assert.equal(h.manager.getLeafId(), leaf, "noninteractive commit is unavailable");
	await h.bridge.command(`commit ${token}`, h.context());
	assert.notEqual(h.manager.getLeafId(), leaf);
	assert.equal((await h.execute({ action: "list" })).details.mode, "v2");
	await h.execute({ action: "add", kind: "gap", text: "Corrected", supersedes: "g0" });
	const archive = await h.tool.execute(
		"archive",
		{ action: "archive", locator: predecessor, limit: 20 },
		undefined,
		undefined,
		h.context(),
	);
	assert.ok(Value.Check(EvidenceResultV2Schema, archive.details));
	assert.equal(archive.details.action, "archive");
	if (archive.details.action === "archive") {
		assert.equal(archive.details.archive.available, true);
		assert.equal(archive.details.total, 512);
		assert.equal(archive.details.records.length, 20);
	}
	await h.bridge.command(`commit ${token}`, h.context());
	assert.match(h.notifications.at(-1) ?? "", /expired/);
	await h.event("session_shutdown");
});

test("confirmation rejects moved branches and replaced sessions; recovery is explicit and never retries", async () => {
	const h = harness();
	await h.event("session_start");
	await h.execute({ action: "add", kind: "gap", text: "Keep" });
	await h.bridge.command("preview --empty", h.context());
	const preview = await h.execute({ action: "preview", selected: [] });
	assert.ok(preview.details.preview);
	h.setConfirm(async () => {
		h.manager.appendSessionInfo("moved");
		return true;
	});
	await h.bridge.command(`commit ${preview.details.preview.token}`, h.context());
	assert.match(h.notifications.at(-1) ?? "", /branch changed/);
	assert.equal((await h.execute({ action: "list" })).details.mode, "legacy");
	h.setAppend((type, data) => {
		h.manager.appendCustomEntry(type, data);
		throw new Error("uncertain");
	});
	await assert.rejects(h.execute({ action: "add", kind: "gap", text: "Visible despite failure" }));
	const leaf = h.manager.getLeafId();
	h.setConfirm(async () => {
		assert.equal(h.bridge.active, true);
		await h.bridge.command("recover", h.context());
		assert.match(h.notifications.at(-1) ?? "", /already open/);
		return false;
	});
	await h.bridge.command("recover", h.context());
	assert.equal(h.bridge.active, false);
	assert.equal((await h.execute({ action: "list" })).details.writable, false);
	h.setConfirm(async () => true);
	await h.bridge.command("recover", h.context());
	assert.equal(h.manager.getLeafId(), leaf, "recovery never retries an append");
	assert.equal((await h.execute({ action: "list" })).details.writable, true);
	const next = await h.execute({ action: "preview", selected: [] });
	assert.ok(next.details.preview);
	h.setConfirm(async () => {
		h.replace();
		await h.event("session_start");
		return true;
	});
	await h.bridge.command(`commit ${next.details.preview.token}`, h.context());
	assert.equal(h.manager.getBranch().length, 0);
	await h.event("session_shutdown");
});

test("replacement suppresses queued operations and old notifications/publication", async () => {
	const h = harness();
	await h.event("session_start");
	const oldContext = h.context();
	const pending = h.execute({ action: "add", kind: "gap", text: "Stale" });
	h.replace();
	await h.event("session_start");
	await assert.rejects(pending, /changed|abort/i);
	assert.equal(h.bridge.summary().gaps, 0);
	await assert.rejects(h.execute({ action: "list" }, undefined, oldContext), /changed/);
	await h.event("tool_result", { toolCallId: "old", toolName: "bash" }, oldContext);
	assert.equal(h.manager.getBranch().length, 0);
	await h.event("session_shutdown");
});
