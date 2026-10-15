import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { AuditResultSchema, planAudit } from "../src/evidence/audit.ts";
import { ENTRY_TYPE, type EvidenceRecord } from "../src/evidence/model.ts";
import { EvidenceResultV2Schema } from "../src/evidence/result-v2.ts";
import { EvidenceRuntimeV2, type EvidenceSourceIO } from "../src/evidence/runtime-v2.ts";
import { replayEvidenceBranch, UncertainEvidenceAppendError } from "../src/evidence/session-store.ts";
import { captureSource, readSource } from "../src/evidence/source.ts";
import { WORKING_SET_ENTRY_TYPE } from "../src/evidence/working-set.ts";

function gap(id: string): EvidenceRecord {
	return {
		id,
		kind: "gap",
		text: id,
		createdAt: "2026-10-14T00:00:00.000Z",
		status: "active",
		refs: [],
		applicability: "historical",
		automatic: false,
	};
}
function harness(
	count = 25,
	yieldPage?: () => Promise<void>,
	options: { cwd?: string; sources?: EvidenceSourceIO } = {},
) {
	const manager = SessionManager.inMemory(options.cwd ?? "runtime-v2");
	for (let i = 0; i < count; i++)
		manager.appendCustomEntry(ENTRY_TYPE, { version: 1, action: "add", record: gap(`g${i}`) });
	const published: unknown[] = [];
	let append: (type: string, data: unknown) => void = (type, data) => {
		manager.appendCustomEntry(type, data);
	};
	const runtime = new EvidenceRuntimeV2(
		(type, data) => append(type, data),
		(result) => published.push(result),
		yieldPage,
		options.sources,
	);
	const ctx = { sessionManager: manager, cwd: manager.getCwd() };
	runtime.start(ctx);
	return {
		runtime,
		manager,
		ctx,
		published,
		setAppend: (fn: typeof append) => {
			append = fn;
		},
	};
}
function barrier() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
function command(): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "nested",
		toolName: "bash",
		parentToolCallId: "codemode",
		input: {},
		content: [],
		details: undefined,
		structuredContent: { exit_code: 7 },
		isError: true,
	};
}
async function migrate(h: ReturnType<typeof harness>, selected = ["g0"]) {
	const preview = await h.runtime.previewRollover(selected);
	assert.ok(preview.preview);
	const result = await h.runtime.commit(preview.preview.token);
	assert.ok(Value.Check(EvidenceResultV2Schema, result));
	return preview.preview.predecessor;
}

test("audit is bounded and observational across source failures, paging and cancellation", async () => {
	let reads = 0;
	let wait: ReturnType<typeof barrier> | undefined;
	const h = harness(0, undefined, {
		sources: {
			capture: captureSource,
			read: async (_cwd, path) => {
				reads++;
				if (wait) await wait.promise;
				if (path === "missing") throw new Error("missing");
				return { sha256: "b".repeat(64) } as Awaited<ReturnType<typeof readSource>>;
			},
		},
	});
	const source = (id: string, path: string): EvidenceRecord => ({
		...gap(id),
		kind: "evidence",
		source: { kind: "file", path, startLine: 1, endLine: 1, quote: "original", sha256: "a".repeat(64) },
	});
	for (let i = 0; i < 34; i++)
		h.manager.appendCustomEntry(ENTRY_TYPE, {
			version: 1,
			action: "add",
			record: source(`e${i}`, i === 0 ? "missing" : `file${i}`),
		});
	for (let i = 0; i < 3; i++)
		h.manager.appendCustomEntry(ENTRY_TYPE, {
			version: 1,
			action: "add",
			record: {
				...gap(`c${i}`),
				kind: "claim",
				applicability: "current",
				refs: Array.from({ length: i === 2 ? 2 : 16 }, (_, n) => `e${i * 16 + n}`),
			},
		});
	const leaf = h.manager.getLeafId();
	const before = JSON.stringify(h.manager.getBranch());
	const first = await h.runtime.audit({ action: "audit", selected: ["c0", "c1", "c2"], limit: 1 });
	assert.ok(Value.Check(AuditResultSchema, first));
	assert.equal(first.filesChecked, 32);
	assert.equal(reads, 32);
	assert.equal(first.legacyRelationships, true);
	assert.equal(first.navigationReviewPending, true);
	assert.equal(first.total, 34);
	assert.equal(first.findings[0].code, "source_unavailable");
	const tail = await h.runtime.audit({ action: "audit", selected: ["c0", "c1", "c2"], offset: 32 });
	assert.ok(tail.findings.every((f) => f.code === "source_not_checked"));
	assert.equal(h.manager.getLeafId(), leaf);
	assert.equal(JSON.stringify(h.manager.getBranch()), before);
	assert.equal(h.published.length, 0);
	const clean = await h.runtime.audit({ action: "audit", selected: ["not-recorded"] });
	assert.equal(clean.findings[0].code, "missing");
	h.manager.appendCustomEntry("midnight-evidence-v2", { version: 99 });
	const unavailable = await h.runtime.audit({ action: "audit", selected: ["c0"] });
	assert.equal(unavailable.available, false);
	assert.equal(unavailable.filesChecked, 0);
	assert.ok(unavailable.issue);
	h.manager.branch(leaf as string); // Seeded history above has a non-null leaf.
	for (const mode of ["cancel", "branch", "replace"] as const) {
		wait = barrier();
		const controller = new AbortController();
		const pending = h.runtime.audit({ action: "audit", selected: ["c0"] }, controller.signal);
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (mode === "cancel") controller.abort();
		if (mode === "branch") h.manager.appendSessionInfo("moved");
		if (mode === "replace") h.runtime.start({ cwd: "other", sessionManager: SessionManager.inMemory("other") });
		wait.release();
		await assert.rejects(pending);
	}
});

test("audit scopes concerns and resolution support, discloses receipts and missing/inactive references", () => {
	const e: EvidenceRecord = {
		...gap("e"),
		kind: "evidence",
		source: { kind: "tool", toolName: "bash", toolCallId: "x", advisory: false, exitCode: 0, sha256: "a".repeat(64) },
	};
	const c: EvidenceRecord = {
		...gap("c"),
		kind: "claim",
		refs: ["e", "missing"],
		review: "Reassess",
		status: "superseded",
	};
	const concern = {
		...gap("g"),
		semantics: 3 as const,
		concerns: ["c"],
		resolvedBy: ["old"],
		refs: ["c", "old"],
		reviewReasons: [],
		reviewOverflow: false,
		status: "resolved" as const,
		review: "Reopened support needs review",
	};
	const state = {
		setId: "test",
		semantics: 3 as const,
		invalidEvents: 0,
		records: [e, c, concern, { ...e, id: "old", status: "retracted" as const }, gap("unrelated")].map((record) => ({
			record,
		})),
	};
	const before = structuredClone(state);
	const plan = planAudit(state, ["c", "absent", "e"]);
	assert.equal(plan.claims[0].applicability, "historical");
	for (const code of [
		"inactive",
		"missing_support",
		"review_required",
		"receipt_only",
		"reviewed_concern",
		"missing",
		"not_claim",
	])
		assert.ok(plan.findings.some((f) => f.code === code));
	assert.ok(plan.findings.some((f) => f.record === "old" && f.code === "inactive"));
	assert.ok(!plan.findings.some((f) => f.record === "unrelated"));
	assert.deepEqual(state, before);
});

test("bounded results, explicit capacity recovery and archive pages preserve historical records", async () => {
	const h = harness(512);
	const initial = await h.runtime.list();
	assert.equal(initial.records.length, 10);
	assert.equal(initial.summary.capacityReached, true);
	const preview = await h.runtime.previewRollover(["g0"], { limit: 2 });
	assert.ok(preview.preview);
	assert.equal(preview.preview.omitted.total, 511);
	assert.equal(preview.preview.omitted.ids.length, 2);
	assert.equal(preview.preview.freeSlots, 511);
	assert.ok(Value.Check(EvidenceResultV2Schema, preview));
	assert.equal(preview.action, "preview");
	assert.equal("event" in preview.preview, false);
	assert.equal(Value.Check(EvidenceResultV2Schema, { ...preview, preview: undefined }), false);
	const previewPage = await h.runtime.previewRollover(["g0"], { offset: 2, limit: 2 });
	assert.equal(previewPage.preview?.token, preview.preview.token);
	assert.equal(previewPage.preview?.omitted.ids[0], "g3");
	assert.equal(Value.Check(EvidenceResultV2Schema, { ...preview, snapshot: [] }), false);
	const committed = await h.runtime.commit(preview.preview.token);
	assert.equal(committed.committed, true);
	await h.runtime.update({ version: 1, action: "add", record: { ...gap("replacement"), supersedes: "g0" } });
	const live = await h.runtime.list();
	assert.equal(live.records[1].record.status, "superseded");
	const archived = await h.runtime.archive(preview.preview.predecessor, { limit: 20 });
	assert.equal(archived.archive?.available, true);
	assert.equal(archived.total, 512);
	assert.equal(archived.records.length, 20);
	assert.equal(archived.records[0].record.status, "active");
	assert.ok(archived.archive?.cursor);
	const next = await h.runtime.archive(archived.archive.cursor, { offset: 20, limit: 2 });
	assert.equal(next.records[0].record.id, "g20");
	assert.ok(Value.Check(EvidenceResultV2Schema, next));
	await assert.rejects(h.runtime.list({ limit: 21 }), /pagination/);
	assert.equal(Value.Check(EvidenceResultV2Schema, { ...initial, records: Array(21).fill(initial.records[0]) }), false);
});

test("queued passive receipts invalidate previews without loss and precede later explicit updates", async () => {
	const h = harness(1);
	await migrate(h);
	await h.runtime.update({
		version: 1,
		action: "add",
		record: {
			...gap("source"),
			kind: "evidence",
			source: { kind: "file", path: "source.ts", sha256: "a".repeat(64), startLine: 1, endLine: 1, quote: "original" },
		},
	});
	await h.runtime.update({
		version: 1,
		action: "add",
		record: {
			...gap("claim"),
			kind: "claim",
			refs: ["source"],
			applicability: "current",
		},
	});
	const preview = await h.runtime.previewRollover(["claim"]);
	assert.ok(preview.preview);
	h.runtime.observeStart("nested", "bash");
	const observed = h.runtime.observeResult(command());
	const stale = h.runtime.commit(preview.preview.token);
	await observed;
	await assert.rejects(stale, /Stale preview/);
	const live = await h.runtime.list();
	assert.equal(live.summary.receipts, 1);
	assert.ok(live.records.find(({ record }) => record.id === "claim")?.record.review);
	const receipt = live.records.find(({ record }) => record.automatic)?.record;
	assert.equal(receipt?.source?.kind === "tool" && receipt.source.exitCode, 7);
	assert.equal(receipt?.source?.kind === "tool" && receipt.source.parentToolCallId, "codemode");
});

test("legacy captures and passive writes serialize before explicit migration without recapturing carried sources", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "midnight-evidence-queued-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "文档 file.ts"), "original\r\n文档 é\n");
	const entered = barrier();
	const held = barrier();
	let captures = 0;
	const h = harness(0, undefined, {
		cwd,
		sources: {
			read: readSource,
			capture: async (...args) => {
				captures++;
				entered.release();
				await held.promise;
				return captureSource(...args);
			},
		},
	});
	const captured = h.runtime.execute({
		action: "add",
		kind: "evidence",
		text: "Unicode source",
		path: "文档 file.ts",
		startLine: 2,
	});
	await entered.promise;
	h.runtime.observeStart("nested", "bash");
	const receipt = h.runtime.observeResult(command());
	const queued = h.runtime.execute({ action: "add", kind: "gap", text: "queued after receipt" });
	assert.equal(h.manager.getEntries().length, 0, "passive appends cannot race a pending source capture");
	held.release();
	const source = (await captured).records[0].record;
	await receipt;
	const g = (await queued).records[0].record;
	const legacy = await h.runtime.list();
	assert.equal(legacy.mode, "legacy");
	assert.equal(legacy.summary.receipts, 1);
	assert.equal(source.source?.kind === "file" && source.source.quote, "文档 é");
	assert.deepEqual(
		legacy.records.map(({ record }) => record.id),
		[g.id, legacy.records[1].record.id, source.id],
	);
	assert.equal(legacy.records[1].record.automatic, true);
	assert.equal(legacy.setId, replayEvidenceBranch(h.manager).state.setId);
	assert.ok(h.manager.getEntries().every((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE));
	const current = (await h.runtime.execute({ action: "add", kind: "claim", text: "Current", refs: [source.id] }))
		.records[0].record;
	const historical = (
		await h.runtime.execute({
			action: "add",
			kind: "claim",
			text: "Historical",
			refs: [source.id],
			applicability: "historical",
		})
	).records[0].record;
	const preview = await h.runtime.previewRollover([current.id, historical.id, g.id]);
	assert.ok(preview.preview);
	h.runtime.observeStart("nested", "bash");
	await h.runtime.observeResult(command());
	await assert.rejects(h.runtime.commit(preview.preview.token), /Stale preview/);
	const fresh = await h.runtime.previewRollover([current.id, historical.id, g.id]);
	assert.ok(fresh.preview);
	const migrated = await h.runtime.commit(fresh.preview.token);
	assert.equal(migrated.mode, "v2");
	assert.ok(migrated.records.find(({ record }) => record.id === current.id)?.record.review);
	assert.equal(migrated.records.find(({ record }) => record.id === historical.id)?.record.review, undefined);
	assert.equal(captures, 1, "rollover preserves observations, not fresh reads");
	assert.equal((await h.runtime.execute({ action: "list", id: source.id })).records[0].record.id, source.id);
	await assert.rejects(h.runtime.execute({ action: "list", id: "absent" }), /not found/);
	h.runtime.start(h.ctx);
	const before = h.manager.getEntries().length;
	const loaded = await h.runtime.list();
	assert.equal(h.manager.getEntries().length, before, "reload never clears review or reviews historical claims");
	assert.equal(loaded.mode, "v2");
	assert.equal(captures, 1);
});

test("queued checks preserve historical sources, deduplicate paths and never clear review in legacy or v2", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "midnight-evidence-check-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	for (const migrated of [false, true]) {
		await writeFile(join(cwd, "source.txt"), "original\n");
		let reads = 0;
		const entered = barrier();
		const held = barrier();
		let hold = false;
		const h = harness(0, undefined, {
			cwd,
			sources: {
				capture: captureSource,
				read: async (...args) => {
					reads++;
					if (hold) {
						entered.release();
						await held.promise;
					}
					return readSource(...args);
				},
			},
		});
		const a = (await h.runtime.execute({ action: "add", kind: "evidence", text: "First", path: "source.txt" }))
			.records[0].record;
		const b = (await h.runtime.execute({ action: "add", kind: "evidence", text: "Second", path: "source.txt" }))
			.records[0].record;
		const c = (await h.runtime.execute({ action: "add", kind: "claim", text: "Current", refs: [a.id] })).records[0]
			.record;
		const g = (await h.runtime.execute({ action: "add", kind: "gap", text: "Gap" })).records[0].record;
		await h.runtime.execute({ action: "resolve", id: g.id, reason: "Observed", refs: [b.id] });
		if (migrated) await migrate(h, [c.id, g.id]);
		const unchanged = await h.runtime.check();
		assert.equal(reads, 1);
		assert.equal(unchanged.committed, undefined);
		assert.equal(unchanged.summary.review, 0);
		assert.ok(Value.Check(EvidenceResultV2Schema, unchanged));
		await writeFile(join(cwd, "source.txt"), "changed\n");
		hold = true;
		reads = 0;
		const before = h.manager.getEntries().length;
		const checked = h.runtime.check();
		await entered.promise;
		const queued = h.runtime.execute({ action: "add", kind: "gap", text: "After check" });
		assert.equal(h.manager.getEntries().length, before);
		held.release();
		const changed = await checked;
		await queued;
		assert.equal(reads, 1);
		assert.equal(changed.committed, true);
		assert.equal(changed.action, "check");
		assert.ok(changed.records.find(({ record }) => record.id === a.id)?.record.review);
		assert.ok(changed.records.find(({ record }) => record.id === c.id)?.record.review);
		assert.equal(changed.records.find(({ record }) => record.id === g.id)?.record.status, "active");
		assert.equal(
			changed.records.find(({ record }) => record.id === a.id)?.record.source?.kind === "file" &&
				a.source?.kind === "file" &&
				a.source.quote,
			"original",
		);
		await writeFile(join(cwd, "source.txt"), "original\n");
		const restored = await h.runtime.check();
		assert.equal(restored.summary.review, changed.summary.review);
		assert.equal(reads, 1, "reviewed files are not automatically revalidated");
		const correction = (
			await h.runtime.execute({
				action: "add",
				kind: "evidence",
				text: "Reassessed",
				path: "source.txt",
				supersedes: a.id,
			})
		).records[0].record;
		assert.equal(correction.review, undefined);
		assert.equal((await h.runtime.execute({ action: "list", id: a.id })).records[0].record.status, "superseded");
		await rm(join(cwd, "source.txt"));
		const missing = await h.runtime.check();
		assert.match(missing.records.find(({ record }) => record.id === correction.id)?.record.review ?? "", /unavailable/);
		assert.deepEqual(replayEvidenceBranch(h.manager).state.records, (await h.runtime.list()).records.reverse());

		const partial = harness(0, undefined, {
			sources: {
				capture: captureSource,
				read: async () => ({ path: "same.txt", sha256: "b".repeat(64), text: "changed" }),
			},
		});
		for (const id of ["first", "second"])
			await partial.runtime.update({
				version: 1,
				action: "add",
				record: {
					...gap(id),
					kind: "evidence",
					source: {
						kind: "file",
						path: "same.txt",
						sha256: "a".repeat(64),
						startLine: 1,
						endLine: 1,
						quote: "original",
					},
				},
			});
		if (migrated) await migrate(partial, ["first", "second"]);
		const controller = new AbortController();
		const beforePartial = partial.manager.getEntries().length;
		partial.setAppend((type, data) => {
			partial.manager.appendCustomEntry(type, data);
			controller.abort();
		});
		const prefix = await partial.runtime.check({}, controller.signal);
		assert.equal(prefix.committed, true);
		assert.equal(prefix.cancelledAfterAppend, true);
		assert.equal(prefix.summary.review, 1, "report the committed prefix, not a completed check or rollback");
		assert.equal(partial.manager.getEntries().length, beforePartial + 1);
		assert.ok(Value.Check(EvidenceResultV2Schema, prefix));
		partial.setAppend((type, data) => {
			partial.manager.appendCustomEntry(type, data);
		});
		assert.equal((await partial.runtime.check()).summary.review, 2);
	}
});

test("source I/O cancellation, replacement and branch races append nothing; navigation reviews through the queue", async () => {
	for (const operation of ["capture", "check"] as const) {
		for (const race of ["cancel", "replace", "branch"] as const) {
			const entered = barrier();
			const held = barrier();
			const source = {
				kind: "file" as const,
				path: "source.txt",
				sha256: "a".repeat(64),
				startLine: 1,
				endLine: 1,
				quote: "original",
			};
			const h = harness(1, undefined, {
				sources: {
					read: async () => {
						entered.release();
						await held.promise;
						return { path: source.path, sha256: "b".repeat(64), text: "changed" };
					},
					capture: async () => {
						entered.release();
						await held.promise;
						return source;
					},
				},
			});
			if (operation === "check") {
				await h.runtime.update({ version: 1, action: "add", record: { ...gap("source"), kind: "evidence", source } });
				h.published.length = 0;
			}
			const controller = new AbortController();
			const pending =
				operation === "check"
					? h.runtime.check({}, controller.signal)
					: h.runtime.execute(
							{ action: "add", kind: "evidence", text: "Pending", path: "source.txt" },
							controller.signal,
						);
			await entered.promise;
			if (race === "cancel") controller.abort();
			else if (race === "replace") h.runtime.start(h.ctx);
			else h.manager.appendSessionInfo("branch interleaving");
			const before = h.manager.getEntries().length;
			held.release();
			await assert.rejects(pending, /abort|session changed|branch changed/i);
			assert.equal(h.manager.getEntries().length, before);
			assert.equal(h.published.length, 0);
			assert.equal((await h.runtime.list()).summary.review, 0);
		}
	}
	const h = harness(1);
	await h.runtime.update({
		version: 1,
		action: "add",
		record: {
			...gap("source"),
			kind: "evidence",
			source: { kind: "file", path: "source.txt", sha256: "a".repeat(64), startLine: 1, endLine: 1, quote: "original" },
		},
	});
	const fork = h.manager.getLeafId();
	await h.runtime.execute({ action: "add", kind: "claim", text: "Current", refs: ["source"] });
	const currentLeaf = h.manager.getLeafId();
	assert.ok(fork && currentLeaf);
	h.manager.branch(fork);
	h.runtime.start(h.ctx);
	await h.runtime.list();
	h.manager.branch(currentLeaf);
	const before = h.manager.getEntries().length;
	h.runtime.start(h.ctx);
	assert.equal(h.manager.getEntries().length, before, "lifecycle reset schedules review without an immediate append");
	const preview = await h.runtime.previewRollover(["source"]);
	assert.ok(preview.preview);
	assert.equal(h.manager.getEntries().length, before + 1, "navigation reviews before preview, not outside the FIFO");
	assert.equal((await h.runtime.list()).summary.claims, 0);
	const publication = h.published.at(-1);
	assert.ok(Value.Check(EvidenceResultV2Schema, publication));
	assert.equal(publication.action, "update");
});

test("cancellation before preview, during paged scans and queued commit appends nothing", async () => {
	const h = harness(1);
	await assert.rejects(h.runtime.previewRollover(["g0"], {}, AbortSignal.abort()), /abort/i);
	const preview = await h.runtime.previewRollover(["g0"]);
	assert.ok(preview.preview);
	const controller = new AbortController();
	const queued = h.runtime.commit(preview.preview.token, controller.signal);
	controller.abort();
	await assert.rejects(queued, /abort/i);
	assert.equal(h.manager.getEntries().length, 1);
	const scanController = new AbortController();
	let pages = 0;
	const scan = harness(1, async () => {
		pages++;
		scanController.abort();
	});
	for (let i = 0; i < 1100; i++) scan.manager.appendSessionInfo("padding");
	await assert.rejects(scan.runtime.list({}, scanController.signal), /abort/i);
	assert.equal(pages, 1);
	assert.equal(scan.published.length, 0);
});

test("generation replacement discards pending scans, passive calls and stale publication", async () => {
	let release!: () => void;
	let entered!: () => void;
	const scanning = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = harness(1, async () => {
		entered();
		await gate;
	});
	for (let i = 0; i < 1100; i++) h.manager.appendSessionInfo("padding");
	const pending = h.runtime.previewRollover(["g0"]);
	await scanning;
	h.runtime.observeStart("nested", "bash");
	const replacement = SessionManager.inMemory("replacement");
	replacement.appendSessionInfo("new root");
	h.runtime.start({ sessionManager: replacement, cwd: replacement.getCwd() });
	release();
	await assert.rejects(pending, /changed|abort/i);
	await h.runtime.observeResult(command());
	assert.equal((await h.runtime.list()).total, 0);
	assert.equal(h.published.length, 0);
});

test("cancellation after append reports committed state; uncertain append locks until explicit recovery", async () => {
	const h = harness(1);
	const preview = await h.runtime.previewRollover(["g0"]);
	assert.ok(preview.preview);
	const controller = new AbortController();
	h.setAppend((type, data) => {
		h.manager.appendCustomEntry(type, data);
		controller.abort();
	});
	const committed = await h.runtime.commit(preview.preview.token, controller.signal);
	assert.equal(committed.committed, true);
	assert.equal(committed.cancelledAfterAppend, true);
	assert.equal(h.published.length, 1);
	h.setAppend((type, data) => {
		h.manager.appendCustomEntry(type, data);
		throw new Error("persist failed");
	});
	await assert.rejects(
		h.runtime.update({ version: 1, action: "add", record: gap("uncertain") }),
		UncertainEvidenceAppendError,
	);
	assert.equal((await h.runtime.list()).appendUncertain, true);
	h.runtime.stop();
	h.runtime.start(h.ctx);
	assert.equal((await h.runtime.list()).appendUncertain, true);
	await assert.rejects(h.runtime.update({ version: 1, action: "add", record: gap("blocked") }), /locked/);
	const recovered = await h.runtime.recover();
	assert.equal(recovered.appendUncertain, false);
	assert.ok(recovered.records.some(({ record }) => record.id === "uncertain"));
	assert.equal(
		h.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === WORKING_SET_ENTRY_TYPE)
			.length,
		2,
		"no retry or rollback",
	);

	for (const timing of ["before", "after"] as const) {
		const legacy = harness(0);
		legacy.setAppend((type, data) => {
			if (timing === "after") legacy.manager.appendCustomEntry(type, data);
			throw new Error("legacy persistence failed");
		});
		await assert.rejects(
			legacy.runtime.execute({ action: "add", kind: "gap", text: "Legacy uncertain" }),
			(error: unknown) => {
				assert.ok(error instanceof UncertainEvidenceAppendError);
				assert.equal(error.visibleOnActiveAncestry, timing === "after");
				return true;
			},
		);
		legacy.runtime.stop();
		legacy.runtime.start(legacy.ctx);
		assert.equal((await legacy.runtime.list()).appendUncertain, true);
		await assert.rejects(legacy.runtime.execute({ action: "add", kind: "gap", text: "Blocked" }), /locked/);
		assert.equal((await legacy.runtime.recover()).appendUncertain, false);
		legacy.setAppend((type, data) => {
			legacy.manager.appendCustomEntry(type, data);
		});
		await legacy.runtime.execute({ action: "add", kind: "gap", text: "After recovery" });
		assert.equal(legacy.manager.getEntries().length, timing === "after" ? 2 : 1);
		for (const entry of legacy.manager.getEntries()) {
			assert.ok(entry.type === "custom" && entry.customType === ENTRY_TYPE);
			assert.ok(entry.data && typeof entry.data === "object");
			assert.equal("operationId" in entry.data, false, "keep the original v1 envelope");
		}
		assert.equal((await legacy.runtime.list()).setId, replayEvidenceBranch(legacy.manager).state.setId);

		const replacement = SessionManager.inMemory("append-time replacement");
		legacy.setAppend((type, data) => {
			legacy.manager.appendCustomEntry(type, data);
			legacy.runtime.start({ sessionManager: replacement, cwd: replacement.getCwd() });
		});
		const published = legacy.published.length;
		await assert.rejects(
			legacy.runtime.execute({ action: "add", kind: "gap", text: "Old generation" }),
			/changed|abort/i,
		);
		assert.equal(legacy.published.length, published);
		assert.equal(
			(await legacy.runtime.list()).total,
			0,
			"never seed a new manager with a stale post-append projection",
		);
	}
});

test("live replay inspects only descendants and falls back safely on sibling navigation", async () => {
	const h = harness(2);
	const fork = h.manager.getLeafId();
	assert.ok(fork);
	for (let i = 0; i < 1100; i++) h.manager.appendSessionInfo("padding");
	const getEntry = h.manager.getEntry.bind(h.manager);
	let inspected = 0;
	h.manager.getEntry = (id) => {
		inspected++;
		return getEntry(id);
	};
	await h.runtime.list();
	assert.equal(inspected, 2204, "collection and replay charge every read, including the root");
	inspected = 0;
	await h.runtime.list();
	assert.equal(inspected, 0);
	h.manager.appendSessionInfo("one descendant");
	await h.runtime.list();
	assert.equal(inspected, 2, "do not scan the validated ancestor again");
	inspected = 0;
	h.manager.appendCustomEntry(ENTRY_TYPE, { version: 1, action: "add", record: gap("late legacy") });
	const legacy = await h.runtime.list();
	assert.equal(inspected, 2);
	assert.equal(legacy.total, 3);
	assert.equal(legacy.setId, replayEvidenceBranch(h.manager).state.setId);

	await migrate(h);
	h.manager.appendSessionInfo("v2 descendant");
	inspected = 0;
	assert.equal((await h.runtime.list()).mode, "v2");
	assert.equal(inspected, 2);
	const v2Leaf = h.manager.getLeafId();
	assert.ok(v2Leaf);
	const snapshot = h.manager
		.getEntries()
		.find((entry) => entry.type === "custom" && entry.customType === WORKING_SET_ENTRY_TYPE);
	assert.ok(snapshot?.type === "custom");
	h.manager.appendCustomEntry(WORKING_SET_ENTRY_TYPE, snapshot.data);
	const duplicate = await h.runtime.list();
	assert.equal(duplicate.writable, false);
	assert.match(duplicate.issue ?? "", /Duplicate evidence operation/);
	h.manager.branch(v2Leaf);
	assert.equal((await h.runtime.list()).mode, "v2");

	h.manager.branch(fork);
	h.manager.appendCustomEntry(ENTRY_TYPE, { version: 1, action: "add", record: gap("sibling") });
	const sibling = await h.runtime.list();
	assert.equal(sibling.mode, "legacy");
	assert.equal(sibling.total, 3);
	assert.equal(
		sibling.records.some(({ record }) => record.id === "late legacy"),
		false,
	);
	assert.equal(sibling.setId, replayEvidenceBranch(h.manager).state.setId);
});

test("cold archive calls bound all inspections and report unknown counts until complete", async () => {
	const h = harness(3);
	const locator = await migrate(h);
	for (let i = 0; i < 2200; i++) h.manager.appendSessionInfo("archive authorization padding");
	h.runtime.stop();
	h.runtime.start(h.ctx);
	const getEntry = h.manager.getEntry.bind(h.manager);
	let inspected = 0;
	h.manager.getEntry = (id) => {
		inspected++;
		return getEntry(id);
	};
	let result = await h.runtime.archive(locator);
	assert.equal(result.archive.inspected, 2048);
	assert.equal(inspected, 2048, "no hidden live synchronization or root/failure reads");
	assert.equal(result.archive.complete, false);
	assert.equal(result.total, null, "unavailable is not a zero-record archive");
	assert.equal("summary" in result, false, "no implied live freshness or counts");
	assert.equal(Value.Check(EvidenceResultV2Schema, { ...result, writable: true }), false);
	while (!result.archive.complete) {
		assert.ok(result.archive.cursor);
		inspected = 0;
		result = await h.runtime.archive(result.archive.cursor);
		assert.equal(result.archive.inspected, inspected, "completion must include the finishing scan's work");
		assert.ok(inspected <= 2048);
	}
	assert.equal(result.archive.available, true);
	assert.equal(result.total, 3);
	assert.ok(Value.Check(EvidenceResultV2Schema, result));
	assert.ok(result.archive.cursor);
	inspected = 0;
	await h.runtime.archive(result.archive.cursor, { offset: 1, limit: 1 });
	assert.equal(inspected, 0);
	h.manager.appendSessionInfo("expire completed archive");
	inspected = 0;
	assert.match((await h.runtime.archive(result.archive.cursor)).issue ?? "", /branch changed/);
	assert.equal(inspected, 0);

	let mismatch = await h.runtime.archive({ ...locator, digest: "0".repeat(64) });
	while (!mismatch.archive.complete) {
		assert.ok(mismatch.archive.cursor);
		inspected = 0;
		mismatch = await h.runtime.archive(mismatch.archive.cursor);
		assert.equal(mismatch.archive.inspected, inspected);
	}
	assert.match(mismatch.issue ?? "", /locator does not match/);
	assert.equal(mismatch.total, null);
	assert.equal(mismatch.records.length, 0);
});

test("branch movement expires archives and malformed or mixed history stays read-only", async () => {
	const h = harness(1);
	const locator = await migrate(h);
	const archive = await h.runtime.archive(locator);
	assert.ok(archive.archive?.cursor);
	h.manager.appendSessionInfo("branch moved");
	assert.match((await h.runtime.archive(archive.archive.cursor)).issue ?? "", /branch changed/);
	h.manager.appendCustomEntry(ENTRY_TYPE, { version: 1, action: "add", record: gap("old writer") });
	const mixed = await h.runtime.list();
	assert.equal(mixed.writable, false);
	assert.equal(mixed.mode, "read-only");
	await assert.rejects(h.runtime.previewRollover(["g0"]), /read-only/);
	await assert.rejects(h.runtime.recover(), /coherent replay/);
});
