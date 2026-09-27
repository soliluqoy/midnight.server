import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVariantList, resolveManifest, seededShuffle } from "./harness-eval-design.mjs";
import { exportRuns } from "./harness-eval-export.mjs";

const FEATURES = ["contextPack", "inRunChecks", "driftGuard", "blockerExit", "escalation", "masking"];

test("a +feature or -feature token extends the variant before it", () => {
	const variants = parseVariantList("bare,harness,no-pack=-contextPack,+driftGuard,guard=+driftGuard");
	assert.deepEqual(
		variants.map((variant) => [variant.name, variant.features]),
		[
			["bare", undefined],
			["harness", ""],
			["no-pack", "-contextPack,+driftGuard"],
			["guard", "+driftGuard"],
		],
	);
	assert.throws(() => parseVariantList("custom"), /use bare, harness/);
});

const manifest = {
	schema_version: 1,
	experiment_id: "pilot",
	task_split: "dev",
	factor_order: ["driftGuard", "blockerExit"],
	fixed: { escalation: false, masking: true },
	variants: [
		{ id: "00", features: { driftGuard: false, blockerExit: false } },
		{ id: "10", features: { driftGuard: true, blockerExit: false } },
		{ id: "01", features: { driftGuard: false, blockerExit: true } },
		{ id: "11", features: { driftGuard: true, blockerExit: true } },
		{ id: "bare", harness: false },
	],
	repeats: 3,
	order_seed: 41,
};

test("a two-factor manifest resolves to exactly four complete assignments plus bare", () => {
	const design = resolveManifest(manifest, FEATURES);
	assert.equal(design.variants.length, 5);
	assert.deepEqual(design.variants[1].assignment, {
		escalation: false,
		masking: true,
		driftGuard: true,
		blockerExit: false,
	});
	assert.equal(design.variants[1].features, "-escalation,+masking,+driftGuard,-blockerExit");
	assert.equal(design.variants[4].harness, false);
	assert.equal(design.repeats, 3);
});

test("a manifest with an unknown, missing, fixed or duplicated factor is rejected", () => {
	const broken = (change) => () => resolveManifest({ ...manifest, ...change }, FEATURES);
	assert.throws(broken({ factor_order: ["driftGaurd"] }), /unknown feature driftGaurd/);
	assert.throws(broken({ variants: [{ id: "a", features: { driftGuard: true } }] }), /factor blockerExit is not assigned/);
	assert.throws(broken({ fixed: { driftGuard: true } }), /both a factor and fixed/);
	assert.throws(
		broken({
			variants: [
				{ id: "a", features: { driftGuard: true, blockerExit: true } },
				{ id: "b", features: { driftGuard: true, blockerExit: true } },
			],
		}),
		/same assignment/,
	);
});

test("the seeded shuffle is a reproducible permutation", () => {
	const items = Array.from({ length: 20 }, (_, index) => index);
	const once = seededShuffle(items, 41);
	assert.deepEqual(seededShuffle(items, 41), once);
	assert.notDeepEqual(once, items);
	assert.deepEqual([...once].sort((a, b) => a - b), items);
});

test("export keeps verified factorial runs and refuses a treatment that did not resolve as assigned", () => {
	const record = (variant, driftGuard, resolved = driftGuard) => ({
		experimentId: "pilot",
		task: "t1",
		family: "f1",
		variant,
		repeat: 0,
		assignment: { driftGuard, escalation: false },
		resolvedFeatures: { driftGuard: resolved, escalation: false },
		artifactPassed: true,
		unchangedOk: true,
		completed: true,
		timedOut: false,
		overBudget: false,
	});
	const { runs, skipped } = exportRuns(
		[record("0", false), record("1", true), { task: "t1", variant: "bare", repeat: 0 }],
		["driftGuard"],
	);
	assert.equal(runs.length, 2);
	assert.deepEqual(runs[1].factors, { driftGuard: true });
	assert.equal(runs[1].cluster_id, "f1");
	assert.equal(skipped.length, 1);
	assert.throws(() => exportRuns([record("1", true, false)], ["driftGuard"]), /differs from the assignment/);
	// A timeout with passing files stays artifact_passed=true; the lab's success needs completion.
	const timedOut = { ...record("1", true), completed: false, timedOut: true };
	assert.deepEqual(
		(({ artifact_passed, completed, timed_out }) => ({ artifact_passed, completed, timed_out }))(
			exportRuns([timedOut], ["driftGuard"]).runs[0],
		),
		{ artifact_passed: true, completed: false, timed_out: true },
	);
});
