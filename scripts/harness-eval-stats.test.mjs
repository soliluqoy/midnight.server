import assert from "node:assert/strict";
import { test } from "node:test";
import {
	categorizeTurn,
	classifyToolError,
	formatReport,
	mcnemarExact,
	pairedComparison,
	variantSummary,
} from "./harness-eval-stats.mjs";

test("categorizes turns by what their tool calls do", () => {
	assert.equal(categorizeTurn([], false), "answer");
	assert.equal(categorizeTurn([{ name: "read" }, { name: "grep" }], false), "explore");
	assert.equal(categorizeTurn([{ name: "edit" }, { name: "read" }], true), "edit");
	assert.equal(categorizeTurn([{ name: "bash", arguments: { command: "npm test" } }], false), "verify");
	assert.equal(categorizeTurn([{ name: "powershell", arguments: { command: "node test.js" } }], false), "verify");
	assert.equal(categorizeTurn([{ name: "read" }], true), "recover");
});

test("classifies tool errors", () => {
	assert.equal(classifyToolError("edit", "Could not find the exact text in a.js."), "edit-no-match");
	assert.equal(classifyToolError("read", "ENOENT: no such file"), "path-not-found");
	assert.equal(classifyToolError("powershell", "The term 'ls -la' is not recognized as"), "command-not-found");
	assert.equal(classifyToolError("edit", "Edit rejected by the harness: it makes a.js invalid"), "edit-broke-syntax");
	assert.equal(classifyToolError("bash", "Command exited with code 1"), "command-failed");
});

test("exact McNemar p-values", () => {
	assert.equal(mcnemarExact(0, 0), 1);
	// 0 vs 6 discordant pairs: 2 * (1/64).
	assert.equal(mcnemarExact(0, 6), 2 / 64);
	assert.equal(mcnemarExact(3, 3), 1);
});

test("paired comparison and summary", () => {
	const records = [];
	for (const task of ["a", "b", "c", "d"]) {
		for (const repeat of [0, 1]) {
			records.push({ task, repeat, variant: "bare", passed: task === "a", input: 100, output: 10, cost: 0.01, cacheRead: 0, elapsedMs: 1000, turns: 5 });
			records.push({ task, repeat, variant: "harness", passed: task !== "d", input: 80, output: 10, cost: 0.01, cacheRead: 0, elapsedMs: 900, turns: 3 });
		}
	}
	const result = pairedComparison(records, "bare", "harness");
	assert.equal(result.tasks, 4);
	assert.equal(result.difference, 0.5);
	assert.equal(result.onlyCandidate, 4);
	assert.equal(result.onlyBase, 0);
	assert.ok(result.low <= 0.5 && result.high >= 0.5);
	const summary = variantSummary(records, "harness");
	assert.equal(summary.passed, 6);
	assert.equal(summary.tokensPerSolved, (90 * 8) / 6);
	const report = formatReport(records, ["bare", "harness"]);
	assert.match(report, /Paired against bare/);
	assert.match(report, /\+50%/);
});
