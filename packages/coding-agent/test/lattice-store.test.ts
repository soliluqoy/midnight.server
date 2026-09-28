import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	issueCapability,
	readTextHost,
	resolveInside,
	scanDirectory,
	verifyCapability,
} from "../src/lattice/broker.ts";
import { runCampaign } from "../src/lattice/campaign.ts";
import { canonical } from "../src/lattice/canonical.ts";
import { recordsFilter, recordsFilterProgram } from "../src/lattice/contracts.ts";
import { Governor, localDay } from "../src/lattice/governor.ts";
import { Lattice } from "../src/lattice/kernel.ts";
import { REFERENCE_POLICY } from "../src/lattice/search.ts";

let dir: string;
let lattice: Lattice;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lattice-store-"));
	lattice = Lattice.open(join(dir, "data"));
	lattice.init({ snapshot: false });
});

afterEach(() => {
	try {
		lattice.close();
	} catch {
		// already closed by the test
	}
	rmSync(dir, { recursive: true, force: true });
});

const better = recordsFilterProgram(["is_log", "old_enough", "size_positive", "visible", "text_hit"]);

describe("lattice versions and promotion", () => {
	it("promotes only when the expected parent is still active (compare-and-swap)", () => {
		const head = lattice.store.head("records.filter")!;
		lattice.store.startCampaign({
			campaignId: "camp_a",
			skillId: "records.filter",
			kind: "program",
			parentVersion: head.version.version_id,
			record: {},
		});
		const promoted = lattice.store.promote({
			skillId: "records.filter",
			expectedParent: head.version.version_id,
			program: better,
			campaignId: "camp_a",
			report: {},
		});
		expect(lattice.store.head("records.filter")!.version.version_id).toBe(promoted);
		lattice.store.startCampaign({
			campaignId: "camp_b",
			skillId: "records.filter",
			kind: "program",
			parentVersion: head.version.version_id,
			record: {},
		});
		expect(() =>
			lattice.store.promote({
				skillId: "records.filter",
				expectedParent: head.version.version_id,
				program: recordsFilter.seed(),
				campaignId: "camp_b",
				report: {},
			}),
		).toThrow(/stale/);
		expect(lattice.store.head("records.filter")!.version.version_id).toBe(promoted);
		expect(lattice.store.version(promoted)!.parent_version).toBe(head.version.version_id);
	});

	it("rolls back by pointer and keeps the failed version; the seed has no parent", () => {
		const seed = lattice.store.head("records.filter")!.version.version_id;
		expect(() => lattice.rollback("records.filter")).toThrow(/no parent/);
		lattice.store.startCampaign({
			campaignId: "camp_r",
			skillId: "records.filter",
			kind: "program",
			parentVersion: seed,
			record: {},
		});
		const promoted = lattice.store.promote({
			skillId: "records.filter",
			expectedParent: seed,
			program: better,
			campaignId: "camp_r",
			report: {},
		});
		expect(lattice.rollback("records.filter")).toEqual({ from: promoted, to: seed });
		expect(lattice.store.version(promoted)!.status).toBe("retired");
		expect(() => lattice.rollback("records.filter", 99_999)).toThrow(/ancestor/);
	});

	it("consumes a release set once, even when the campaign crashes right after reserving it", async () => {
		const before = lattice.store.head("records.filter")!.version.version_id;
		await expect(
			runCampaign(lattice, {
				skillId: "records.filter",
				contract: recordsFilter,
				policy: REFERENCE_POLICY,
				policyHash: "test",
				explore: true,
				isolate: false,
				shadowMin: 0,
				onReserved: () => {
					throw new Error("simulated crash");
				},
			}),
		).rejects.toThrow(/simulated crash/);
		expect(lattice.store.head("records.filter")!.version.version_id).toBe(before);
		const reserved = lattice.store.db.prepare("SELECT release_set_id, verdict FROM consumed_releases_v1").all() as {
			release_set_id: string;
			verdict: string;
		}[];
		expect(reserved).toEqual([{ release_set_id: "records.filter/r1/release/001", verdict: "reserved" }]);
		const report = await lattice.improve("records.filter", {
			explore: true,
			isolate: false,
			policy: "reference",
			shadowMin: 0,
		});
		expect((report.release as { release_set_id: string }).release_set_id).toBe("records.filter/r1/release/002");
		expect(report.status).toBe("promoted");
	});

	it("refuses to promote without live shadow evidence unless the operator waives it", async () => {
		const report = await lattice.improve("records.filter", { explore: true, isolate: false, policy: "reference" });
		expect(report.status).toBe("incomplete");
		expect(report.gate?.reasons).toContain("missing shadowPassed");
		expect(lattice.store.head("records.filter")!.version.seed).toBe(1);
	});

	it("rejects a changed contract that did not bump its revision", () => {
		expect(() => lattice.store.ensureContractRow("records.filter", 1, "0".repeat(64))).toThrow(
			/without a new revision/,
		);
	});
});

describe("lattice integrity and recovery", () => {
	it("detects audit tampering on open and stops promotion", () => {
		lattice.close();
		const db = new DatabaseSync(join(dir, "data", "lattice.db"));
		db.exec("UPDATE audit SET payload = '{\"forged\":true}' WHERE seq = 2");
		db.close();
		lattice = Lattice.open(join(dir, "data"));
		expect(lattice.store.paused).toMatch(/audit chain broken at record 2/);
		const head = lattice.store.head("records.filter")!;
		expect(() =>
			lattice.store.promote({
				skillId: "records.filter",
				expectedParent: head.version.version_id,
				program: better,
				campaignId: "x",
				report: {},
			}),
		).toThrow(/integrity failure/);
	});

	it("restores the last valid ancestor of a corrupt active version and requires a diagnostic run", () => {
		const seed = lattice.store.head("records.filter")!.version.version_id;
		lattice.store.startCampaign({
			campaignId: "camp_c",
			skillId: "records.filter",
			kind: "program",
			parentVersion: seed,
			record: {},
		});
		const promoted = lattice.store.promote({
			skillId: "records.filter",
			expectedParent: seed,
			program: better,
			campaignId: "camp_c",
			report: {},
		});
		const hash = lattice.store.version(promoted)!.program_hash;
		lattice.store.db
			.prepare("UPDATE programs_v1 SET canonical_ir = ? WHERE program_hash = ?")
			.run(canonical(recordsFilter.seed()).replace("ERROR", "EROR"), hash);
		const report = lattice.store.verify();
		expect(report.corruptHeads).toEqual(["records.filter"]);
		expect(lattice.store.recover()).toEqual([{ skillId: "records.filter", from: promoted, to: seed }]);
		expect(lattice.store.version(promoted)!.status).toBe("invalid");
		expect(lattice.store.head("records.filter")!.promotionEnabled).toBe(false);
		expect(lattice.store.verify().ok).toBe(true);
		const diagnostic = lattice.test("records.filter");
		expect(diagnostic.passed && diagnostic.reenabled).toBe(true);
	});

	it("stores artifacts by content and detects corrupted bytes", () => {
		const hash = lattice.store.putArtifact(Buffer.from("report"), "text/plain", "test");
		expect(lattice.store.putArtifact(Buffer.from("report"), "text/plain", "test")).toBe(hash);
		expect(lattice.store.readArtifact(hash).toString()).toBe("report");
		writeFileSync(lattice.store.artifactPath(hash), "tampered");
		expect(() => lattice.store.readArtifact(hash)).toThrow(/corrupt/);
	});

	it("creates and verifies snapshots, and notices a modified snapshot", () => {
		const { snapshotId, path } = lattice.store.createSnapshot("policy");
		expect(lattice.store.verifySnapshot(snapshotId).ok).toBe(true);
		expect(lattice.store.listSnapshots().map((snapshot) => snapshot.snapshot_id)).toEqual([snapshotId]);
		const db = new DatabaseSync(join(path, "lattice.db"));
		db.exec("UPDATE meta SET value = 'x' WHERE key = 'kernel_version'");
		db.close();
		expect(lattice.store.verifySnapshot(snapshotId).problems).toContain("snapshot database hash mismatch");
	});
});

describe("lattice resource governor", () => {
	it("reserves daily CPU before a campaign and refuses when the day is spent", () => {
		const governor = new Governor(lattice.store, 15_000);
		const allocation = governor.allocate("background");
		expect(governor.remainingToday()).toBe(5_000);
		expect(() => governor.allocate("background")).toThrow(/daily improvement budget exhausted/);
		governor.release(allocation);
		expect(governor.remainingToday()).toBeGreaterThan(5_000);
		// An unreconciled reservation (a crash) stays charged in full.
		lattice.store.ledgerReserve(localDay(), 14_000);
		expect(governor.remainingToday()).toBeLessThanOrEqual(1_000);
	});
});

describe("lattice effect broker", () => {
	const key = "k".repeat(64);

	it("scans without following links, marks hidden paths and rejects forged or foreign capabilities", () => {
		const root = join(dir, "tree");
		mkdirSync(join(root, "src", ".cache"), { recursive: true });
		writeFileSync(join(root, "src", "a.ts"), "export {};");
		writeFileSync(join(root, "src", ".cache", "x.json"), "{}");
		writeFileSync(join(root, "README.md"), "# hi");
		const outside = join(dir, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.txt"), "secret");
		let linked = true;
		try {
			symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
		} catch {
			linked = false;
		}
		const capability = issueCapability(key, { root, verbs: ["list", "read"], episodeId: "ep_1" });
		const snapshot = scanDirectory(key, capability, "ep_1", 100);
		expect(snapshot.entries.map((entry) => [entry.path, entry.kind, entry.hidden])).toEqual([
			["README.md", "file", false],
			["src", "dir", false],
			["src/.cache", "dir", true],
			["src/.cache/x.json", "file", true],
			["src/a.ts", "file", false],
		]);
		if (linked) expect(snapshot.skipped).toEqual([{ path: "escape", reason: "symlink (not followed)" }]);
		const host = readTextHost(key, capability, "ep_1");
		expect(host.readText("src/a.ts", 100)).toBe("export {};");
		expect(() => host.readText("../outside/secret.txt", 100)).toThrow(/parent traversal/);
		expect(() => host.readText(join(outside, "secret.txt"), 100)).toThrow(/absolute/);
		if (linked) expect(() => host.readText("escape/secret.txt", 100)).toThrow(/escapes/);
		expect(() => verifyCapability(key, { ...capability, root: outside }, "list", "ep_1")).toThrow(/signature/);
		expect(() => verifyCapability(key, capability, "list", "ep_2")).toThrow(/another episode/);
		const listOnly = issueCapability(key, { root, verbs: ["list"], episodeId: "ep_1" });
		expect(() => readTextHost(key, listOnly, "ep_1").readText("README.md", 10)).toThrow(/does not grant read/);
		const expired = issueCapability(key, { root, verbs: ["list"], episodeId: "ep_1", ttlMs: -1 });
		expect(() => scanDirectory(key, expired, "ep_1", 100)).toThrow(/expired/);
		expect(() => scanDirectory(key, capability, "ep_1", 2)).toThrow(/more than 2 entries/);
		expect(() => resolveInside(root, "a/../../b")).toThrow(/traversal/);
	});
});
