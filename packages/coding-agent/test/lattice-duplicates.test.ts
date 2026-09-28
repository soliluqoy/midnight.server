import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentHashHost, issueCapability, scanDirectory } from "../src/lattice/broker.ts";
import { canonical } from "../src/lattice/canonical.ts";
import { duplicatesReport, syntheticContentHost } from "../src/lattice/contracts.ts";
import { evaluateSuite } from "../src/lattice/evaluator.ts";
import { interpret } from "../src/lattice/interpreter.ts";
import type { Program, Value } from "../src/lattice/ir.ts";
import { Lattice } from "../src/lattice/kernel.ts";
import { INSTALLATION_LIMITS } from "../src/lattice/limits.ts";
import { enumerateMutations } from "../src/lattice/mutate.ts";
import { PRIMITIVES } from "../src/lattice/primitives.ts";
import { PyRandom } from "../src/lattice/random.ts";
import { checkProgram } from "../src/lattice/typecheck.ts";

const context = { limits: INSTALLATION_LIMITS, library: new Map() };
const GUARD = new Set(["insert_implied_guard"] as const);

function guards(program: Program) {
	const check = checkProgram(program, {
		limits: INSTALLATION_LIMITS,
		granted: new Set(duplicatesReport.granted),
		library: new Map(),
		inputSummary: duplicatesReport.inputBounds,
	});
	if (!check.ok) throw new Error(check.error);
	return enumerateMutations(program, check.info, GUARD);
}

describe("duplicates.report contract", () => {
	it("has a correct seed on every fixture family and on fuzzed inputs", () => {
		const seed = duplicatesReport.seed();
		const cases = [
			...duplicatesReport.fixtures.development(),
			...duplicatesReport.fixtures.regression(),
			...duplicatesReport.fixtures.release(1).slice(0, 4),
			...duplicatesReport.fixtures.shifted(1).slice(0, 2),
			...Array.from({ length: 50 }, (_, i) => duplicatesReport.fuzz!(new PyRandom(i))),
		];
		const suite = evaluateSuite(duplicatesReport, seed, cases, context);
		expect(suite.failures).toEqual([]);
		expect(suite.allCorrect).toBe(true);
	});

	it("counts content groups, excludes hidden files and treats empty files as equal", () => {
		const regression = duplicatesReport.fixtures.regression()[1];
		expect(duplicatesReport.oracle(regression)).toEqual([
			{ path: "c~g1.bin", copies: 2 },
			{ path: "d~g1.bin", copies: 2 },
			{ path: "f~g2.bin", copies: 3 },
			{ path: "g~g2.bin", copies: 3 },
			{ path: "h~g2.bin", copies: 3 },
			{ path: "x.txt", copies: 2 },
			{ path: "y.txt", copies: 2 },
		]);
	});

	it("refuses a hash whose declared size differs from the file, as the broker does", () => {
		const host = syntheticContentHost([{ path: "a.bin", size: 5, hidden: false, kind: "file" }] as unknown as Value);
		expect(() => host.contentHash!("a.bin", 6)).toThrow(/size differs/);
		expect(host.contentHash!("a.bin", 5)).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("implied-guard insertion", () => {
	it("is declared only by content_hash, for its size argument", () => {
		const declaring = [...PRIMITIVES.values()].filter((primitive) => primitive.equalityImplies);
		expect(declaring.map((primitive) => [primitive.id, primitive.equalityImplies])).toEqual([["content_hash", [1]]]);
	});

	it("guards each hash comparison with a size comparison, once, keeping results and cutting cost", () => {
		const seed = duplicatesReport.seed();
		const first = guards(seed);
		expect(first).toHaveLength(2);
		const second = guards(first[0].program);
		expect(second).toHaveLength(1);
		const guarded = second[0].program;
		expect(guards(guarded)).toHaveLength(0);

		const cases = [...duplicatesReport.fixtures.development().slice(0, 2), ...duplicatesReport.fixtures.regression()];
		const before = evaluateSuite(duplicatesReport, seed, cases, context);
		const after = evaluateSuite(duplicatesReport, guarded, cases, context);
		expect(after.allCorrect).toBe(true);
		const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
		expect(sum(after.costs)).toBeLessThan(sum(before.costs) / 10);
		for (const input of cases) {
			const host = syntheticContentHost(input);
			const run = interpret(guarded, input, { ...context, host });
			expect(run.ok && canonical(run.value)).toBe(canonical(duplicatesReport.oracle(input, host)));
		}
	});
});

let dir: string;
let root: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lattice-duplicates-"));
	root = join(dir, "tree");
	mkdirSync(join(root, "sub"), { recursive: true });
	for (const [path, text] of [
		["a.txt", "same content"],
		["sub/b.txt", "same content"],
		[".hidden.txt", "same content"],
		["c.txt", "diff content"],
		["d.txt", "other"],
		["e.txt", ""],
		["sub/f.txt", ""],
	]) {
		writeFileSync(join(root, path), text);
	}
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("broker content hashing (spec section 43.4)", () => {
	const key = "k".repeat(64);
	const open = (verbs: ("list" | "read")[] = ["list", "read"]) => {
		const capability = issueCapability(key, { root, verbs, episodeId: "ep" });
		const snapshot = scanDirectory(key, capability, "ep", 100);
		return { snapshot, host: contentHashHost(key, capability, "ep", snapshot.identities) };
	};
	const sha = (text: string) => createHash("sha256").update(text).digest("hex");

	it("returns the SHA-256 of the bytes and reads each file once per episode", () => {
		const { host } = open();
		expect(host.contentHash!("a.txt", 12)).toBe(sha("same content"));
		expect(host.contentHash!("sub/b.txt", 12)).toBe(sha("same content"));
		expect(host.contentHash!("c.txt", 12)).toBe(sha("diff content"));
		expect(host.contentHash!("e.txt", 0)).toBe(sha(""));
		expect(host.contentHash!("a.txt", 12)).toBe(sha("same content"));
		expect(host.observed).toEqual({ files: 4, bytes: 36, cacheHits: 1 });
	});

	it("refuses a size other than the inventory's, files outside the inventory, and a missing read grant", () => {
		const { host } = open();
		expect(() => host.contentHash!("a.txt", 11)).toThrow(/size differs/);
		expect(() => host.contentHash!("missing.txt", 1)).toThrow(/not in the inventory/);
		expect(() => host.contentHash!("../a.txt", 12)).toThrow(/not in the inventory/);
		expect(() => open(["list"]).host.contentHash!("a.txt", 12)).toThrow(/does not grant read/);
	});

	it("reports unstable input when a file changed since the inventory, even from its cache", () => {
		const { host } = open();
		expect(host.contentHash!("a.txt", 12)).toBe(sha("same content"));
		writeFileSync(join(root, "a.txt"), "SAME CONTENT");
		const past = new Date(2020, 0, 1);
		utimesSync(join(root, "a.txt"), past, past);
		expect(() => host.contentHash!("a.txt", 12)).toThrow(/unstable input/);
		writeFileSync(join(root, "d.txt"), "OTHER");
		utimesSync(join(root, "d.txt"), past, past);
		expect(() => host.contentHash!("d.txt", 5)).toThrow(/unstable input/);
		rmSync(join(root, "c.txt"));
		expect(() => host.contentHash!("c.txt", 12)).toThrow(/unstable input/);
	});
});

describe("duplicates.report through the kernel", () => {
	let lattice: Lattice;

	beforeEach(() => {
		lattice = Lattice.open(join(dir, "data"));
		lattice.init({ snapshot: false });
	});

	afterEach(() => {
		lattice.close();
	});

	it("reports duplicates by real content and never answers from the metadata cache", async () => {
		const first = await lattice.submitGoal({ contract_id: "duplicates.report", directory: root });
		expect(first.status).toBe("completed");
		expect(first.output).toEqual([
			{ path: "a.txt", copies: 2 },
			{ path: "e.txt", copies: 2 },
			{ path: "sub/b.txt", copies: 2 },
			{ path: "sub/f.txt", copies: 2 },
		]);
		expect(first.summary).toMatchObject({ duplicate_files: 4, content_groups: 2 });
		expect(first.evidence.join("\n")).toMatch(/exact content: \d+ files hashed by streaming SHA-256/);

		// Same sizes, so the same inventory; only the contents differ.
		writeFileSync(join(root, "sub/b.txt"), "SAME CONTENT");
		const second = await lattice.submitGoal({ contract_id: "duplicates.report", directory: root });
		expect(second.skill_used?.engine).not.toBe("cache");
		expect(second.output).toEqual([
			{ path: "e.txt", copies: 2 },
			{ path: "sub/f.txt", copies: 2 },
		]);
	});

	it("asks for a directory instead of reading contents it cannot see", async () => {
		const structured = await lattice.submitGoal({
			contract_id: "duplicates.report",
			input: duplicatesReport.fixtures.regression()[1],
		});
		expect(structured).toMatchObject({ status: "needs_clarification", failure_class: "input_ambiguity" });
		expect((await lattice.submitGoal({ text: "find duplicates" })).status).toBe("needs_clarification");
		const text = await lattice.submitGoal({ text: `duplicates in "${root}"` });
		expect(text.status).toBe("completed");
		expect(() => lattice.runSkill("duplicates.report", [])).toThrow(/reads file contents/);
	});

	it("replays live episodes by rescanning their directories, skipping those that are gone", async () => {
		await lattice.submitGoal({ contract_id: "duplicates.report", directory: root });
		const live = lattice.episodeInputs(duplicatesReport, 5);
		expect(live).toHaveLength(1);
		const host = lattice.hostFor(duplicatesReport)!(live[0]);
		expect(host.contentHash!("a.txt", 12)).toBe(host.contentHash!("sub/b.txt", 12));
		rmSync(root, { recursive: true, force: true });
		expect(lattice.episodeInputs(duplicatesReport, 5)).toEqual([]);
	});

	it("finds the size guard in a campaign, promotes it, compiles it and mines alongside it", async () => {
		await lattice.submitGoal({ contract_id: "duplicates.report", directory: root });
		const report = await lattice.improve("duplicates.report", { explore: true, isolate: true });
		expect(report.status).toBe("promoted");
		const release = report.release as { lineage: string[]; shadow: string; mean_virtual_cost_reduction: number };
		expect(release.lineage.join("\n")).toMatch(/compare content_hash argument 1/);
		expect(release.shadow).toBe("1 live snapshots");
		expect(release.mean_virtual_cost_reduction).toBeGreaterThan(0.5);

		const compiled = lattice.compile("duplicates.report");
		expect(compiled.accepted).toBe(true);
		expect(() => lattice.mine()).not.toThrow();

		const after = await lattice.submitGoal({ contract_id: "duplicates.report", directory: root });
		expect(after.skill_used?.version).toBe(report.promoted_version);
		expect((after.output as unknown[]).length).toBe(4);
	}, 180_000);
});
