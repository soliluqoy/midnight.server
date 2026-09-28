import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonical } from "../src/lattice/canonical.ts";
import { main } from "../src/lattice/cli.ts";
import { inventoryReport, recordFixture, recordsFilter, recordsFilterProgram } from "../src/lattice/contracts.ts";
import type { Value } from "../src/lattice/ir.ts";
import { CANARY_RUNS, Lattice, selftest } from "../src/lattice/kernel.ts";
import { INBOX_LIMIT, KernelLoop, serve } from "../src/lattice/server.ts";
import { runIsolated } from "../src/lattice/worker.ts";

let dir: string;
let lattice: Lattice;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lattice-kernel-"));
	lattice = Lattice.open(join(dir, "data"));
	lattice.init({ snapshot: false });
});

afterEach(() => {
	lattice.close();
	rmSync(dir, { recursive: true, force: true });
});

function tree(): string {
	const root = join(dir, "project");
	mkdirSync(join(root, "src", "lib"), { recursive: true });
	mkdirSync(join(root, ".git"), { recursive: true });
	writeFileSync(join(root, "src", "index.ts"), "export const a = 1;\n");
	writeFileSync(join(root, "src", "lib", "util.JS"), "module.exports = {};\n");
	writeFileSync(join(root, "README.md"), "# project\n");
	writeFileSync(join(root, "data.json"), "{}\n");
	writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(root, "Makefile"), "all:\n");
	writeFileSync(join(root, "ファイル.png"), "png");
	return root;
}

describe("lattice hot path", () => {
	it("inventories a directory read-only, verifies postconditions, records the episode and caches", async () => {
		const root = tree();
		const first = await lattice.submitGoal({ contract_id: "inventory.report", directory: root });
		expect(first.status).toBe("completed");
		expect(first.skill_used?.engine).toBe("interpreter");
		expect(first.output).toEqual(inventoryReport.oracle(inventoryReport.validateInput(scanEntries())));
		expect(first.summary.files_reported).toBe(6);
		expect(first.evidence.join("\n")).toMatch(/postconditions passed/);
		const second = await lattice.submitGoal({ contract_id: "inventory.report", directory: root });
		expect(second.skill_used?.engine).toBe("cache");
		expect(second.output).toEqual(first.output);
		const episode = lattice.explainEpisode(first.goal_id) as { status: string; plan: { tier: string } };
		expect(episode.status).toBe("completed");
		expect(episode.plan.tier).toBe("active-skill");
	});

	it("asks for clarification instead of guessing, and works with no adapter at all", async () => {
		const unclear = await lattice.submitGoal({ text: "inventory" });
		expect(unclear.status).toBe("needs_clarification");
		expect(unclear.questions).toEqual(["which directory should be inventoried?"]);
		const unknown = await lattice.submitGoal({ text: "make me a sandwich" });
		expect(unknown.status).toBe("needs_clarification");
		lattice.adapter = undefined;
		expect((await lattice.submitGoal({ text: `inventory ${tree()}` })).status).toBe("needs_clarification");
		const structured = await lattice.submitGoal({ contract_id: "records.filter", input: recordFixture(3) });
		expect(structured.status).toBe("completed");
		expect(structured.output).toEqual(recordsFilter.oracle(recordFixture(3) as unknown as Value));
	});

	it("declines what it has no capability for and rejects invalid input", async () => {
		expect(
			(await lattice.submitGoal({ contract_id: "records.filter", input: [], constraints: { network: "allow" } }))
				.status,
		).toBe("declined");
		const invalid = await lattice.submitGoal({ contract_id: "records.filter", input: [{ id: 1 }] });
		expect(invalid.status).toBe("failed");
		expect(invalid.error).toMatch(/invalid input/);
	});
});

function scanEntries(): unknown {
	// The same walk the broker does, written independently for the test oracle.
	const entries = [
		{ path: ".git", size: 0, hidden: true, kind: "dir" },
		{ path: ".git/HEAD", size: 21, hidden: true, kind: "file" },
		{ path: "Makefile", size: 5, hidden: false, kind: "file" },
		{ path: "README.md", size: 10, hidden: false, kind: "file" },
		{ path: "data.json", size: 3, hidden: false, kind: "file" },
		{ path: "src", size: 0, hidden: false, kind: "dir" },
		{ path: "src/index.ts", size: 20, hidden: false, kind: "file" },
		{ path: "src/lib", size: 0, hidden: false, kind: "dir" },
		{ path: "src/lib/util.JS", size: 21, hidden: false, kind: "file" },
		{ path: "ファイル.png", size: 3, hidden: false, kind: "file" },
	];
	return entries;
}

describe("lattice canary lifecycle", () => {
	it("confirms a canary as champion after agreeing live runs", async () => {
		const report = await lattice.improve("records.filter", {
			explore: true,
			isolate: false,
			policy: "reference",
			shadowMin: 0,
		});
		expect(report.status).toBe("promoted");
		const version = report.promoted_version!;
		expect(lattice.store.version(version)!.status).toBe("canary");
		for (let i = 0; i < CANARY_RUNS; i++) {
			const result = await lattice.submitGoal({ contract_id: "records.filter", input: recordFixture(500 + i) });
			expect(result.status).toBe("completed");
		}
		expect(lattice.store.version(version)!.status).toBe("champion");
		expect(lattice.store.version(lattice.store.version(version)!.parent_version!)!.status).toBe("retired");
		const explanation = lattice.explainSkill("records.filter");
		expect(explanation.text[0]).toMatch(/passed release set records\.filter\/r1\/release\/001/);
		expect(explanation.text[0]).toMatch(/retained as the rollback target/);
	});

	it("rolls a wrong canary back on the first live disagreement and returns the parent's verified result", async () => {
		const seed = lattice.store.head("records.filter")!.version.version_id;
		// A wrong candidate (a predicate dropped) forced in, as if the evaluator had been fooled.
		const wrong = recordsFilterProgram(["is_log", "old_enough", "size_positive", "visible"]);
		lattice.store.startCampaign({
			campaignId: "camp_w",
			skillId: "records.filter",
			kind: "program",
			parentVersion: seed,
			record: {},
		});
		lattice.store.promote({
			skillId: "records.filter",
			expectedParent: seed,
			program: wrong,
			campaignId: "camp_w",
			report: {},
		});
		const input = recordFixture(7);
		const result = await lattice.submitGoal({ contract_id: "records.filter", input });
		expect(result.status).toBe("completed");
		expect(canonical(result.output)).toBe(canonical(recordsFilter.oracle(input as unknown as Value)));
		expect(lattice.store.head("records.filter")!.version.version_id).toBe(seed);
		expect(lattice.store.regressions(recordsFilter)).toHaveLength(1);
	});
});

describe("lattice canary failure", () => {
	it("rolls back a canary that fails at runtime and answers with the restored parent", async () => {
		const seed = lattice.store.head("records.filter")!.version.version_id;
		// Correct logic but a loop bound far too small for real inputs: a runtime bound error on live data.
		const fragile = recordsFilterProgram(["is_log", "old_enough", "size_positive", "visible", "text_hit"]);
		const body = fragile.body as { list: { maxItems: number } };
		body.list.maxItems = 10;
		lattice.store.startCampaign({
			campaignId: "camp_f",
			skillId: "records.filter",
			kind: "program",
			parentVersion: seed,
			record: {},
		});
		lattice.store.promote({
			skillId: "records.filter",
			expectedParent: seed,
			program: fragile,
			campaignId: "camp_f",
			report: {},
		});
		const input = recordFixture(11);
		const result = await lattice.submitGoal({ contract_id: "records.filter", input });
		expect(result.status).toBe("completed");
		expect(result.skill_used?.version).toBe(seed);
		expect(result.output).toEqual(recordsFilter.oracle(input as unknown as Value));
		expect(lattice.store.auditLog("records.filter", 5).some((entry) => entry.kind === "rollback")).toBe(true);
	});
});

describe("lattice compilation and engine choice", () => {
	it("compiles after a differential test and lets the bandit try both verified engines", async () => {
		const compiled = lattice.compile("records.filter");
		expect(compiled.accepted).toBe(true);
		expect(compiled.mismatches).toEqual([]);
		const engines = new Set<string>();
		for (let i = 0; i < 4; i++) {
			const result = await lattice.submitGoal({ contract_id: "records.filter", input: recordFixture(900 + i) });
			expect(result.status).toBe("completed");
			engines.add(result.skill_used!.engine);
		}
		expect(engines).toEqual(new Set(["interpreter", "bytecode"]));
	});
});

describe("lattice isolated improvement", () => {
	it("runs the development search in a worker thread and promotes through the release gate", async () => {
		for (const seed of [1, 2]) {
			await lattice.submitGoal({
				contract_id: "inventory.report",
				input: inventoryReport.fixtures.development()[seed],
			});
		}
		const report = await lattice.improve("inventory.report", { explore: true, isolate: true });
		expect(report.status).toBe("promoted");
		expect(report.development!.bestCost).toBeLessThan(report.development!.parentCost);
		expect(report.gate).toEqual({ verdict: "pass", reasons: [] });
		expect((report.release as { shadow: string }).shadow).toBe("2 live snapshots");
		expect(report.cpu_ms).toBeLessThan(30_000);
	}, 60_000);

	it("terminates the worker when cancelled", async () => {
		const controller = new AbortController();
		const pending = runIsolated(
			{
				kind: "search",
				contractId: "inventory.report",
				parent: inventoryReport.seed(),
				costCases: inventoryReport.fixtures.development(),
				checkCases: inventoryReport.fixtures.regression(),
				policy: lattice.policy().record,
				limits: lattice.limits,
				library: [],
				seed: 1,
				wallMs: 30_000,
				verifierTrials: 0,
			},
			undefined,
			controller.signal,
		);
		setTimeout(() => controller.abort(), 50);
		await expect(pending).rejects.toThrow(/cancelled/);
	});
});

describe("lattice event loop and IPC", () => {
	it("runs interactive work first, cancels background work, and answers busy when full", async () => {
		const loop = new KernelLoop();
		const order: string[] = [];
		const background = loop.submit(
			false,
			(signal) =>
				new Promise((resolve) => {
					signal.addEventListener("abort", () => {
						order.push("background cancelled");
						resolve("cancelled");
					});
				}),
		);
		const interactive = loop.submit(true, async () => {
			order.push("interactive");
			return "done";
		});
		expect(await interactive).toBe("done");
		expect(await background).toBe("cancelled");
		expect(order).toEqual(["background cancelled", "interactive"]);
		const blocker = new KernelLoop();
		const hold: Promise<unknown>[] = [];
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		hold.push(blocker.submit(true, () => gate));
		for (let i = 0; i < INBOX_LIMIT; i++) hold.push(blocker.submit(true, async () => i));
		await expect(blocker.submit(true, async () => 0)).rejects.toThrow(/busy/);
		release();
		await Promise.all(hold);
	});

	it("serves the local API on a pipe with a token and refuses browsers", async () => {
		const path =
			process.platform === "win32"
				? `\\\\.\\pipe\\lattice-test-${process.pid}-${Date.now()}`
				: join(dir, "api.sock");
		const { server, token } = serve(lattice, { path });
		try {
			const call = (method: string, route: string, headers: Record<string, string>, body?: unknown) =>
				new Promise<{ status: number; body: unknown }>((resolve, reject) => {
					const req = request(
						{
							socketPath: path,
							method,
							path: route,
							headers: { "content-type": "application/json", ...headers },
						},
						(res) => {
							const chunks: Buffer[] = [];
							res.on("data", (chunk: Buffer) => chunks.push(chunk));
							res.on("end", () =>
								resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) }),
							);
						},
					);
					req.on("error", reject);
					req.end(body === undefined ? undefined : JSON.stringify(body));
				});
			expect((await call("GET", "/v1/skills", {})).status).toBe(401);
			expect(
				(await call("GET", "/v1/skills", { authorization: `Bearer ${token}`, origin: "https://evil.example" }))
					.status,
			).toBe(403);
			const goal = await call(
				"POST",
				"/v1/goals",
				{ authorization: `Bearer ${token}` },
				{ contract_id: "records.filter", input: recordFixture(1) },
			);
			expect(goal.status).toBe(200);
			expect((goal.body as { status: string }).status).toBe("completed");
			const skills = await call("GET", "/v1/skills", { authorization: `Bearer ${token}` });
			expect((skills.body as { skill: string }[]).map((row) => row.skill)).toContain("inventory.report");
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

describe("lattice CLI and self-test", () => {
	it("passes the end-to-end self-test", async () => {
		const result = await selftest();
		expect(result.selftest).toBe("passed");
		expect(result.permutations_checked).toBe(120);
	}, 60_000);

	it("prints JSON for status and policy check", async () => {
		const lines: string[] = [];
		expect(await main(["--data", join(dir, "cli"), "init"], (text) => lines.push(text))).toBe(0);
		expect(await main(["--data", join(dir, "cli"), "policy", "check"], (text) => lines.push(text))).toBe(0);
		expect(JSON.parse(lines[1])).toMatchObject({ within_governor_limits: true, integrity: true });
	});
});
