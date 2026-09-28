import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/lattice/canonical.ts";
import { FAULT_EXIT_CODE, type FaultPoint } from "../src/lattice/fault.ts";
import { Lattice } from "../src/lattice/kernel.ts";

/**
 * Crash injection by real process death (spec section 46.2): a child process runs one operation
 * and exits hard at a named point; the test reopens the store and requires the state to be old,
 * new, or explicitly unresolved.
 */
const DRIVER = fileURLToPath(new URL("./lattice-fault-driver.ts", import.meta.url));

let dir: string;
let data: string;

function crash(fault: FaultPoint, action: string, argument = ""): void {
	const result = spawnSync(process.execPath, [DRIVER, data, action, argument], {
		env: { ...process.env, LATTICE_FAULT: fault },
		encoding: "utf8",
		timeout: 60_000,
	});
	expect(result.status, result.stderr).toBe(FAULT_EXIT_CODE);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lattice-faults-"));
	data = join(dir, "data");
	const lattice = Lattice.open(data);
	lattice.init({ snapshot: false });
	lattice.close();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("lattice crash injection (milestone M2)", () => {
	it("a crash before the promotion commit leaves the old version active", () => {
		crash("promote-before-commit", "promote");
		const lattice = Lattice.open(data);
		try {
			const head = lattice.store.head("records.filter")!;
			expect(head.version.seed).toBe(1);
			expect(lattice.store.versions("records.filter")).toHaveLength(1);
			expect(lattice.store.verify().ok).toBe(true);
			expect(lattice.store.paused).toBeUndefined();
		} finally {
			lattice.close();
		}
	});

	it("a crash right after the promotion commit leaves the new version active and consistent", () => {
		crash("promote-after-commit", "promote");
		const lattice = Lattice.open(data);
		try {
			const head = lattice.store.head("records.filter")!;
			expect(head.version.seed).toBe(0);
			expect(head.version.status).toBe("canary");
			expect(lattice.store.verify().ok).toBe(true);
			expect(lattice.store.auditLog("records.filter", 1)[0].kind).toBe("promote");
		} finally {
			lattice.close();
		}
	});

	it("a crash between artifact bytes and the database row leaves only collectable garbage", () => {
		const content = "bytes written before the row";
		crash("artifact-before-row", "artifact", content);
		const lattice = Lattice.open(data);
		try {
			const hash = sha256(Buffer.from(content));
			expect(existsSync(lattice.store.artifactPath(hash))).toBe(true);
			expect(lattice.store.db.prepare("SELECT 1 FROM artifacts WHERE hash = ?").get(hash)).toBeUndefined();
			expect(lattice.store.verify().ok).toBe(true);
			lattice.store.collectGarbage(0);
			expect(existsSync(lattice.store.artifactPath(hash))).toBe(false);
		} finally {
			lattice.close();
		}
	});

	it("a crash during snapshot creation leaves no listed, half-written snapshot", () => {
		crash("snapshot-before-manifest", "snapshot");
		const lattice = Lattice.open(data);
		try {
			expect(readdirSync(join(data, "snapshots"))).toHaveLength(1);
			expect(lattice.store.listSnapshots()).toEqual([]);
			expect(lattice.store.verify().ok).toBe(true);
		} finally {
			lattice.close();
		}
	});

	for (const [fault, resolution] of [
		["effect-after-prepare", "unperformed"],
		["effect-after-rename", "committed"],
	] as const) {
		it(`a crash at ${fault} is reconciled as ${resolution} and the plan can finish`, async () => {
			const root = join(dir, "tree");
			mkdirSync(root);
			writeFileSync(join(root, "a.ts"), "a");
			writeFileSync(join(root, "b.md"), "b");
			let lattice = Lattice.open(data);
			const planned = await lattice.submitGoal({ contract_id: "organize.plan", directory: root });
			const planId = planned.plan!.plan_id;
			lattice.close();
			crash(fault, "apply", planId);
			lattice = Lattice.open(data);
			try {
				expect(lattice.recovered).toEqual([{ plan_id: planId, op_index: 0, resolution }]);
				const report = lattice.applyPlan(planId);
				expect(report.status).toBe("applied");
				expect(existsSync(join(root, "code", "a.ts")) && existsSync(join(root, "docs", "b.md"))).toBe(true);
				expect(lattice.store.verify().ok).toBe(true);
			} finally {
				lattice.close();
			}
		});
	}
});
