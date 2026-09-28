import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueCapability } from "../src/lattice/broker.ts";
import { applyPlan } from "../src/lattice/effects.ts";
import { Lattice } from "../src/lattice/kernel.ts";

let dir: string;
let root: string;
let data: string;
let lattice: Lattice;

function files(): string[] {
	const out: string[] = [];
	const walk = (rel: string) => {
		for (const name of readdirSync(join(root, rel), { withFileTypes: true })) {
			const path = rel ? `${rel}/${name.name}` : name.name;
			if (name.isDirectory()) {
				out.push(`${path}/`);
				walk(path);
			} else out.push(path);
		}
	};
	walk("");
	return out.sort();
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lattice-effects-"));
	root = join(dir, "tree");
	data = join(dir, "data");
	mkdirSync(join(root, "code"), { recursive: true });
	mkdirSync(join(root, "sub"));
	for (const [path, text] of [
		["a.ts", "a"],
		["b.ts", "b"],
		["notes.md", "notes"],
		["pic.png", "png"],
		["run.exe", "exe"],
		[".hidden.ts", "hidden"],
		["code/a.ts", "existing"],
		["sub/deep.md", "deep"],
	]) {
		writeFileSync(join(root, path), text);
	}
	lattice = Lattice.open(data);
	lattice.init({ snapshot: false });
});

afterEach(() => {
	lattice.close();
	rmSync(dir, { recursive: true, force: true });
});

const ORIGINAL = [
	".hidden.ts",
	"a.ts",
	"b.ts",
	"code/",
	"code/a.ts",
	"notes.md",
	"pic.png",
	"run.exe",
	"sub/",
	"sub/deep.md",
];

async function propose(): Promise<string> {
	const result = await lattice.submitGoal({ contract_id: "organize.plan", directory: root });
	expect(result.status).toBe("awaiting_approval");
	expect(result.output).toEqual([
		{ from: "b.ts", to: "code/b.ts" },
		{ from: "notes.md", to: "docs/notes.md" },
		{ from: "pic.png", to: "media/pic.png" },
	]);
	expect(files()).toEqual(ORIGINAL);
	return result.plan!.plan_id;
}

describe("lattice effect plans (milestone M9)", () => {
	it("changes nothing until approval, applies with a journal, and undoes exactly", async () => {
		const planId = await propose();
		const applied = lattice.applyPlan(planId);
		expect(applied).toMatchObject({ status: "applied", committed: 3, failed: [] });
		expect(files()).toEqual([
			".hidden.ts",
			"a.ts",
			"code/",
			"code/a.ts",
			"code/b.ts",
			"docs/",
			"docs/notes.md",
			"media/",
			"media/pic.png",
			"run.exe",
			"sub/",
			"sub/deep.md",
		]);
		expect(readFileSync(join(root, "media", "pic.png"), "utf8")).toBe("png");
		expect(() => lattice.applyPlan(planId)).toThrow(/is applied/);
		const kinds = lattice.store.auditLog(planId, 50).map((entry) => entry.kind);
		expect(kinds.filter((kind) => kind === "effect_prepared")).toHaveLength(3);
		expect(kinds.filter((kind) => kind === "effect_committed")).toHaveLength(3);
		expect(lattice.undoPlan(planId)).toMatchObject({ status: "compensated", compensated: 3, unresolved: [] });
		// Directories the plan created are removed; the pre-existing `code/` stays.
		expect(files()).toEqual(ORIGINAL);
	});

	it("stops at a source that changed after planning; earlier moves stay and can be undone", async () => {
		const planId = await propose();
		writeFileSync(join(root, "pic.png"), "edited by the user after the plan");
		const report = lattice.applyPlan(planId);
		expect(report.status).toBe("partial");
		expect(report.committed).toBe(2);
		expect(report.failed).toEqual([{ index: 2, reason: "source changed or vanished since the plan was made" }]);
		expect(existsSync(join(root, "media"))).toBe(false);
		expect(readFileSync(join(root, "pic.png"), "utf8")).toBe("edited by the user after the plan");
		expect(lattice.undoPlan(planId).compensated).toBe(2);
		expect(files()).toEqual(ORIGINAL);
	});

	it("never overwrites a destination that appeared after planning", async () => {
		const planId = await propose();
		mkdirSync(join(root, "docs"));
		writeFileSync(join(root, "docs", "notes.md"), "someone else's notes");
		const report = lattice.applyPlan(planId);
		expect(report.failed).toEqual([{ index: 1, reason: "destination exists" }]);
		expect(readFileSync(join(root, "docs", "notes.md"), "utf8")).toBe("someone else's notes");
		expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("notes");
	});

	it("refuses expired and tampered plans", async () => {
		const expired = await propose();
		lattice.store.db.prepare("UPDATE effect_plans SET expires_at = 0 WHERE plan_id = ?").run(expired);
		expect(() => lattice.applyPlan(expired)).toThrow(/expired/);
		expect(lattice.store.plan(expired)!.status).toBe("expired");
		const tampered = await propose();
		const plan = lattice.store.plan(tampered)!;
		lattice.store.db
			.prepare("UPDATE effect_plans SET intents_json = ? WHERE plan_id = ?")
			.run(plan.intents_json.replace("code/b.ts", "../escaped.ts"), tampered);
		expect(() => lattice.applyPlan(tampered)).toThrow(/modified after it was proposed/);
		expect(files()).toEqual(ORIGINAL);
	});

	it("will not undo over a file the user changed after the move", async () => {
		const planId = await propose();
		lattice.applyPlan(planId);
		writeFileSync(join(root, "docs", "notes.md"), "rewritten after the move");
		const report = lattice.undoPlan(planId);
		expect(report.status).toBe("unresolved");
		expect(report.compensated).toBe(2);
		expect(report.unresolved.map((entry) => entry.index)).toEqual([1]);
		expect(readFileSync(join(root, "docs", "notes.md"), "utf8")).toBe("rewritten after the move");
	});

	it("reconciles a crash after `prepared` as unperformed, then finishes idempotently", async () => {
		const planId = await propose();
		expect(() =>
			lattice.applyPlan(planId, {
				afterPrepared: (index) => {
					if (index === 1) throw new Error("simulated crash");
				},
			}),
		).toThrow(/simulated crash/);
		expect(files()).toContain("code/b.ts");
		expect(files()).toContain("notes.md");
		lattice.close();
		lattice = Lattice.open(data);
		expect(lattice.recovered).toEqual([{ plan_id: planId, op_index: 1, resolution: "unperformed" }]);
		expect(lattice.store.plan(planId)!.status).toBe("partial");
		const report = lattice.applyPlan(planId);
		expect(report).toMatchObject({ status: "applied", committed: 2, skipped_already_committed: 1 });
	});

	it("reconciles a crash between rename and commit as committed, and undo still works", async () => {
		const planId = await propose();
		expect(() =>
			lattice.applyPlan(planId, {
				afterRename: (index) => {
					if (index === 2) throw new Error("simulated crash");
				},
			}),
		).toThrow(/simulated crash/);
		lattice.close();
		lattice = Lattice.open(data);
		expect(lattice.recovered).toEqual([{ plan_id: planId, op_index: 2, resolution: "committed" }]);
		expect(lattice.store.plan(planId)!.status).toBe("applied");
		expect(lattice.undoPlan(planId).status).toBe("compensated");
		// Recovery could not know whether `media/` was created by the plan, so it is kept (empty).
		expect(files()).toEqual([...ORIGINAL, "media/"].sort());
	});

	it("pauses an ambiguous interrupted move instead of guessing", async () => {
		const planId = await propose();
		expect(() =>
			lattice.applyPlan(planId, {
				afterPrepared: (index) => {
					if (index === 0) throw new Error("simulated crash");
				},
			}),
		).toThrow(/simulated crash/);
		writeFileSync(join(root, "code", "b.ts"), "a different file at the destination");
		lattice.close();
		lattice = Lattice.open(data);
		expect(lattice.recovered).toEqual([{ plan_id: planId, op_index: 0, resolution: "unresolved" }]);
		expect(lattice.store.plan(planId)!.status).toBe("unresolved");
		expect((lattice.status() as { plans_needing_attention: unknown[] }).plans_needing_attention).toEqual([
			{ plan_id: planId, status: "unresolved" },
		]);
		expect(() => lattice.applyPlan(planId)).toThrow(/is unresolved/);
	});

	it("rejects capabilities for another root or without the rename verb, and link components", async () => {
		const planId = await propose();
		const key = lattice.store.getMeta("capability_key")!;
		const plan = lattice.store.plan(planId)!;
		const other = join(dir, "other");
		mkdirSync(other);
		const foreign = issueCapability(key, { root: other, verbs: ["rename"], episodeId: plan.episode_id });
		expect(() => applyPlan(lattice.store, key, foreign, planId)).toThrow(/root differs/);
		const listOnly = issueCapability(key, { root, verbs: ["list"], episodeId: plan.episode_id });
		expect(() => applyPlan(lattice.store, key, listOnly, planId)).toThrow(/does not grant rename/);
		let linked = true;
		try {
			symlinkSync(other, join(root, "docs"), process.platform === "win32" ? "junction" : "dir");
		} catch {
			linked = false;
		}
		if (linked) {
			const report = lattice.applyPlan(planId);
			expect(report.failed[0]).toEqual({ index: 1, reason: "docs is a link" });
			expect(existsSync(join(other, "notes.md"))).toBe(false);
		}
	});
});
