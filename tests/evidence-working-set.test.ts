import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { type EvidenceEvent, EvidenceLedger, type EvidenceRecord, MAX_RECORDS } from "../src/evidence/model.ts";
import {
	applyScopedEvent,
	canonicalJson,
	legacyWorkingSet,
	MAX_CARRIED_RECORDS,
	MAX_SNAPSHOT_BYTES,
	previewRollover,
	projectionDigest,
	type ScopedEvent,
	validateRollover,
	type WorkingSet,
} from "../src/evidence/working-set.ts";

const setId = "00000000-0000-4000-8000-000000000001";
const nextId = "00000000-0000-4000-8000-000000000002";
const operationId = "00000000-0000-4000-8000-000000000003";
const anchor = "branch-entry";
function record(id: string, overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
	return {
		id,
		kind: "evidence",
		text: "Synthetic observation",
		createdAt: "2026-10-14T00:00:00.000Z",
		status: "active",
		refs: [],
		applicability: "historical",
		automatic: false,
		source: { kind: "file", path: "文档 file.ts", sha256: "a".repeat(64), startLine: 1, endLine: 1, quote: "文档" },
		...overrides,
	};
}
const gap = (id: string, overrides: Partial<EvidenceRecord> = {}) =>
	record(id, { kind: "gap", source: undefined, ...overrides });
const claim = (id: string, refs: string[], overrides: Partial<EvidenceRecord> = {}) =>
	record(id, { kind: "claim", source: undefined, applicability: "current", refs, ...overrides });
function add(ledger: EvidenceLedger, record: EvidenceRecord): void {
	assert.ok(ledger.apply({ version: 1, action: "add", record }));
}
function update(state: WorkingSet, operation: EvidenceEvent): ScopedEvent {
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
function migrate(ledger: EvidenceLedger, selected: string[]): WorkingSet {
	const state = legacyWorkingSet(ledger, "session/root-entry");
	const preview = previewRollover(state, anchor, selected, setId, operationId);
	return validateRollover(state, anchor, preview.event, preview.token);
}

test("full v1 ledger can explicitly roll over and then correct, without mutating its predecessor", () => {
	const ledger = new EvidenceLedger();
	add(ledger, record("source"));
	add(ledger, claim("claim", ["source"]));
	for (let i = ledger.records.size; i < MAX_RECORDS; i++) add(ledger, gap(`g${i}`));
	assert.equal(ledger.apply({ version: 1, action: "add", record: record("new", { supersedes: "source" }) }), false);
	const before = structuredClone([...ledger.records]);
	const legacy = legacyWorkingSet(ledger, "session/root-entry");
	const preview = previewRollover(legacy, anchor, ["claim"], setId, operationId);
	assert.equal(preview.freeSlots, 510);
	assert.equal(preview.omittedActiveIds.length, 510);
	assert.match(preview.warnings.join(" "), /invalid legacy events/);
	const carried = validateRollover(legacy, anchor, preview.event, preview.token);
	const corrected = applyScopedEvent(
		carried,
		anchor,
		update(carried, { version: 1, action: "add", record: record("new", { supersedes: "source" }) }),
	);
	assert.equal(corrected.records.length, 3);
	assert.equal(corrected.records[0].record.status, "superseded");
	assert.ok(corrected.records[1].record.review);
	assert.equal(carried.records[0].record.status, "active");
	assert.deepEqual([...ledger.records], before);
	assert.deepEqual(corrected.records[2].replacement, { setId, anchor, recordId: "source" });
});

test("closure preserves inactive support and review exactly, not unselected dependents or lineage ancestors", () => {
	const ledger = new EvidenceLedger();
	add(ledger, record("old"));
	add(ledger, claim("claim", ["old"]));
	add(ledger, gap("gap", { refs: ["claim"] }));
	add(ledger, record("new", { supersedes: "old" }));
	const state = migrate(ledger, ["claim"]);
	assert.deepEqual(
		state.records.map(({ record }) => record.id),
		["old", "claim"],
	);
	assert.deepEqual(
		state.records.map(({ record }) => record),
		[ledger.records.get("old"), ledger.records.get("claim")],
	);
	const replacementOnly = migrate(ledger, ["new"]);
	assert.equal(replacementOnly.records.length, 1);
	assert.equal(replacementOnly.records[0].replacement?.recordId, "old");
	const preview = previewRollover(replacementOnly, "second-anchor", ["new"], nextId, operationId);
	const second = validateRollover(replacementOnly, "second-anchor", preview.event, preview.token);
	assert.deepEqual(second.records[0].replacement, replacementOnly.records[0].replacement);
	assert.deepEqual(second.records[0].origin, { setId, anchor: "second-anchor", recordId: "new" });
	assert.deepEqual(second.records[0].record, ledger.records.get("new"));
});

test("resolved gaps retain resolution support and review, then reopen on support invalidation", () => {
	const ledger = new EvidenceLedger();
	add(ledger, record("source"));
	add(ledger, gap("gap"));
	assert.ok(ledger.apply({ version: 1, action: "review", id: "gap", reason: "Unsettled" }));
	assert.ok(ledger.apply({ version: 1, action: "resolve", id: "gap", reason: "Observed", refs: ["source"] }));
	const state = migrate(ledger, ["gap"]);
	assert.equal(state.records[1].record.status, "resolved");
	assert.equal(state.records[1].record.review, "Unsettled");
	const next = applyScopedEvent(
		state,
		anchor,
		update(state, { version: 1, action: "review", id: "source", reason: "Changed" }),
	);
	assert.equal(next.records[1].record.status, "active");
	assert.match(next.records[1].record.review ?? "", /Changed/);
	assert.equal(state.records[1].record.status, "resolved");
});

test("canonical digest ignores object insertion order but preserves record, ref and review state", () => {
	const ledger = new EvidenceLedger();
	add(ledger, record("source"));
	add(ledger, gap("gap"));
	const state = legacyWorkingSet(ledger, "stable");
	assert.equal(state.setId, legacyWorkingSet(ledger, "stable").setId);
	assert.notEqual(state.setId, legacyWorkingSet(ledger, "other-session").setId);
	const reordered = JSON.parse(
		JSON.stringify(state, (_key, value) =>
			value && typeof value === "object" && !Array.isArray(value)
				? Object.fromEntries(Object.entries(value).reverse())
				: value,
		),
	);
	assert.equal(projectionDigest(state), projectionDigest(reordered));
	assert.notEqual(projectionDigest(state), projectionDigest({ ...state, records: [...state.records].reverse() }));
	const changed = structuredClone(state);
	changed.records[0].record.review = "Requires reassessment";
	assert.notEqual(projectionDigest(state), projectionDigest(changed));
});

test("stale branch, changed evidence, different selection and tampered snapshots reject without mutation", () => {
	const ledger = new EvidenceLedger();
	add(ledger, record("source"));
	add(ledger, claim("claim", ["source"]));
	const state = legacyWorkingSet(ledger, "stable");
	const before = structuredClone(state);
	const preview = previewRollover(state, anchor, ["claim"], setId, operationId);
	assert.throws(() => validateRollover(state, "other-branch", preview.event, preview.token), /Stale/);
	const changed = structuredClone(state);
	changed.records[1].record.review = "Passive invalidation arrived";
	assert.throws(() => validateRollover(changed, anchor, preview.event, preview.token), /Stale/);
	for (const mutate of [
		(event: typeof preview.event) => {
			event.records[0].record.text = "Altered";
		},
		(event: typeof preview.event) => {
			event.records[0].record.createdAt = "new time";
		},
		(event: typeof preview.event) => {
			event.records[0].record.status = "retracted";
		},
		(event: typeof preview.event) => {
			assert.ok(event.records[0].origin);
			event.records[0].origin.anchor = "sibling";
		},
		(event: typeof preview.event) => {
			event.records.pop();
		},
		(event: typeof preview.event) => {
			event.records.reverse();
		},
		(event: typeof preview.event) => {
			event.selected = ["source"];
		},
		(event: typeof preview.event) => {
			event.invalidEvents++;
		},
	]) {
		const tampered = structuredClone(preview.event);
		mutate(tampered);
		assert.throws(() => validateRollover(state, anchor, tampered, preview.token), /Stale/);
	}
	assert.deepEqual(state, before);
	const accepted = validateRollover(state, anchor, preview.event, preview.token);
	accepted.records[0].record.text = "Mutated result";
	assert.deepEqual(state, before);
	assert.notEqual(preview.event.records[0].record.text, "Mutated result");
});

test("record closure limit counts dependencies and accepts exactly 256; empty selection is explicit", () => {
	const ledger = new EvidenceLedger();
	for (let i = 0; i < 257; i++) add(ledger, gap(`g${i}`, { refs: i ? [`g${i - 1}`] : [] }));
	const state = legacyWorkingSet(ledger, "stable");
	assert.equal(previewRollover(state, anchor, ["g255"], setId, operationId).event.records.length, MAX_CARRIED_RECORDS);
	assert.throws(() => previewRollover(state, anchor, ["g256"], setId, operationId), /257\/256/);
	assert.throws(() => previewRollover(state, anchor, ["g0", "g0"], setId, operationId), /selection/);
	assert.throws(() => previewRollover(state, anchor, ["absent"], setId, operationId), /Unknown/);
	const empty = previewRollover(state, anchor, [], setId, operationId);
	assert.equal(empty.event.records.length, 0);
	assert.equal(empty.omittedActiveIds.length, 257);
	assert.match(empty.warnings.join(" "), /empty rollover/);
	assert.equal(state.records.length, 257);
});

test("snapshot budget measures serialized UTF-8 bytes, not characters", () => {
	const ledger = new EvidenceLedger();
	for (let i = 0; i < 256; i++)
		add(ledger, gap(`g${i}`, { text: "文".repeat(2000), review: "文".repeat(2000), reason: "文".repeat(2000) }));
	const state = legacyWorkingSet(ledger, "stable");
	const small = previewRollover(state, anchor, ["g0"], setId, operationId);
	assert.equal(small.bytes, Buffer.byteLength(JSON.stringify(small.event), "utf8"));
	assert.ok(small.bytes > JSON.stringify(small.event).length);
	assert.ok(small.bytes < MAX_SNAPSHOT_BYTES);
	assert.throws(
		() =>
			previewRollover(
				state,
				anchor,
				state.records.map(({ record }) => record.id),
				setId,
				operationId,
			),
		/UTF-8 bytes/,
	);
	assert.equal(state.records.length, 256);
});

test("carry and scoped updates enforce file and receipt budgets without silently truncating", () => {
	const ledger = new EvidenceLedger();
	for (let i = 0; i < 33; i++) add(ledger, record(`e${i}`));
	const legacy = legacyWorkingSet(ledger, "stable");
	assert.throws(
		() =>
			previewRollover(
				legacy,
				anchor,
				legacy.records.map(({ record }) => record.id),
				setId,
				operationId,
			),
		/33\/32/,
	);
	const fullFiles = migrate(
		ledger,
		legacy.records.slice(0, 32).map(({ record }) => record.id),
	);
	assert.throws(
		() =>
			applyScopedEvent(fullFiles, anchor, update(fullFiles, { version: 1, action: "add", record: record("extra") })),
		/33\/32/,
	);
	const corrected = applyScopedEvent(
		fullFiles,
		anchor,
		update(fullFiles, { version: 1, action: "add", record: record("replacement", { supersedes: "e0" }) }),
	);
	assert.equal(corrected.records.length, 33);
	const receipts = new EvidenceLedger();
	for (let i = 0; i < 129; i++)
		add(
			receipts,
			record(`r${i}`, {
				automatic: true,
				source: {
					kind: "tool",
					toolCallId: `call${i}`,
					toolName: "bash",
					sha256: "b".repeat(64),
					exitCode: 0,
					advisory: false,
				},
			}),
		);
	const old = legacyWorkingSet(receipts, "stable");
	const selection = old.records.slice(0, 128).map(({ record }) => record.id);
	const preview = previewRollover(old, anchor, selection, setId, operationId);
	assert.match(preview.warnings.join(" "), /no capacity for new automatic/);
	assert.throws(() => previewRollover(old, anchor, [...selection, "r128"], setId, operationId), /129\/128/);
	const state = validateRollover(old, anchor, preview.event, preview.token);
	const extraReceipt = receipts.records.get("r128");
	assert.ok(extraReceipt);
	assert.throws(
		() => applyScopedEvent(state, anchor, update(state, { version: 1, action: "add", record: extraReceipt })),

		/129\/128/,
	);
});

test("frozen v1 fixture retains invalid count and ambiguous prose through JSON rollover round-trip", async () => {
	const fixture = JSON.parse(await readFile(new URL("fixtures/evidence-v1.json", import.meta.url), "utf8"));
	const ledger = new EvidenceLedger();
	for (const event of [...fixture.events, ...fixture.invalidEvents]) ledger.apply(event);
	const legacy = legacyWorkingSet(ledger, "stable");
	const preview = previewRollover(legacy, anchor, ["legacy-gap", "legacy-claim"], setId, operationId);
	const state = validateRollover(legacy, anchor, JSON.parse(JSON.stringify(preview.event)), preview.token);
	assert.equal(state.invalidEvents, 3);
	assert.deepEqual(
		state.records.map(({ record }) => record),
		[...ledger.records.values()],
	);
	assert.equal(state.records[0].record.review, "Legacy prose does not identify a precise review category");
	assert.equal(state.records[1].record.review, undefined);
});

test("strict v2 envelopes reject unknown fields/versions, wrong sets, legacy writes and stale/repeated updates", () => {
	const ledger = new EvidenceLedger();
	add(ledger, record("source"));
	const legacy = legacyWorkingSet(ledger, "stable");
	const preview = previewRollover(legacy, anchor, ["source"], setId, operationId);
	for (const bad of [
		{ ...preview.event, version: 3 },
		{ ...preview.event, extra: true },
		{ ...preview.event, records: [{ ...preview.event.records[0], unexpected: true }] },
		{
			...preview.event,
			records: [{ ...preview.event.records[0], record: { ...preview.event.records[0].record, unexpected: true } }],
		},
	])
		assert.throws(() => validateRollover(legacy, anchor, bad, preview.token), /Malformed/);
	const state = validateRollover(legacy, anchor, preview.event, preview.token);
	const event = update(state, { version: 1, action: "review", id: "source", reason: "Changed" });
	for (const bad of [
		event.operation,
		{ ...event, version: 3 },
		{ ...event, extra: true },
		{ ...event, setId: nextId },
		{ ...event, baseDigest: "0".repeat(64) },
	])
		assert.throws(() => applyScopedEvent(state, anchor, bad));
	assert.throws(() => applyScopedEvent(state, "sibling-anchor", event), /branch anchor/);
	const next = applyScopedEvent(state, anchor, event);
	assert.throws(() => applyScopedEvent(next, anchor, event), /stale/);
	assert.throws(() => previewRollover(next, anchor, ["source"], setId, operationId), /new working-set/);
	assert.equal(state.records[0].record.review, undefined);
});

test("invalid dependencies, cycles, duplicates and missing lineage cannot be laundered by rollover", () => {
	const ledger = new EvidenceLedger();
	add(ledger, gap("a"));
	add(ledger, gap("b", { refs: ["a"] }));
	const state = legacyWorkingSet(ledger, "stable");
	for (const mutate of [
		(s: WorkingSet) => {
			s.records[0].record.refs = ["missing"];
		},
		(s: WorkingSet) => {
			s.records[0].record.refs = ["b"];
		},
		(s: WorkingSet) => {
			s.records.push(structuredClone(s.records[0]));
		},
		(s: WorkingSet) => {
			s.records[0].record.supersedes = "missing";
		},
	]) {
		const bad = structuredClone(state);
		mutate(bad);
		const before = canonicalJson(bad);
		assert.throws(() => previewRollover(bad, anchor, ["b"], setId, operationId));
		assert.equal(canonicalJson(bad), before);
	}
});
