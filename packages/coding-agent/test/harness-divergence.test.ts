import { describe, expect, it } from "vitest";
import { formatCheckFeedback } from "../src/harness/checks.ts";
import {
	ApproachArchive,
	boostedLevel,
	changeFingerprint,
	divergenceFeedback,
	isRepeat,
	similarity,
} from "../src/harness/divergence.ts";
import { TEST_COMMAND } from "../src/harness/extension.ts";

const patch = (removed: string, added: string, file = "port.js") =>
	[
		`--- a/${file}`,
		`+++ b/${file}`,
		"@@ -1,3 +1,3 @@",
		" function parsePort(n) {",
		`-${removed}`,
		`+${added}`,
		" }",
	].join("\n");

describe("divergence", () => {
	it("boosts one step, starts from low, and stops at the ceiling", () => {
		expect(boostedLevel("off")).toBe("low");
		expect(boostedLevel("minimal")).toBe("low");
		expect(boostedLevel("low")).toBe("medium");
		expect(boostedLevel("medium")).toBe("high");
		expect(boostedLevel("high")).toBeUndefined();
		expect(boostedLevel("xhigh")).toBeUndefined();
		expect(boostedLevel("high", "xhigh")).toBe("xhigh");
		expect(boostedLevel("medium", "medium")).toBeUndefined();
	});

	it("fingerprints ignore whitespace and diff headers", () => {
		const a = changeFingerprint(patch("  if (n < 0) return false;", "  if (n <= 0) return false;"));
		const b = changeFingerprint(patch("\tif (n < 0)   return false;", "\tif (n <= 0) return false;", "other.js"));
		expect(similarity(a, b)).toBe(1);
		expect(similarity(new Set(), new Set())).toBe(1);
	});

	it("names a retry that repeats a rejected attempt and not a different one", () => {
		const archive = new ApproachArchive();
		const first = archive.record(["unit"], patch("  return n;", "  if (n <= 0) throw new RangeError('port');"));
		expect(first.closest).toBeUndefined();
		// The same change again, re-indented, with its first line now at a different place: a cosmetic retry.
		const again = archive.record(["unit"], patch("  return n;", "\tif (n <= 0)   throw new RangeError('port');"));
		expect(isRepeat(again)).toBe(true);
		expect(again.closest?.attempt.number).toBe(1);
		const different = archive.record(
			["unit"],
			patch(
				"  return n;",
				"  const value = Number.parseInt(String(n), 10); return Number.isInteger(value) ? value : NaN;",
			),
		);
		expect(isRepeat(different)).toBe(false);
		const text = divergenceFeedback(archive, again);
		expect(text).toMatch(/This attempt is \d+% the same change as attempt 1/);
		expect(text).toContain("1. port.js: `if (n <= 0) throw new RangeError('port');`");
		expect(text).toContain("name three causes that differ in kind");
		expect(divergenceFeedback(archive, different)).not.toContain("the same change as attempt");
	});

	it("uses a configurable threshold", () => {
		const archive = new ApproachArchive();
		archive.record(["unit"], patch("a", "x = a + b + c + d"));
		const next = archive.record(["unit"], patch("a", "x = a + b + c + e"));
		const score = next.closest?.similarity ?? 0;
		expect(score).toBeGreaterThan(0);
		expect(score).toBeLessThan(1);
		expect(isRepeat(next, score)).toBe(true);
		expect(isRepeat(next, Math.min(1, score + 0.01))).toBe(false);
	});

	it("replaces the two-hypothesis request when divergence feedback is given", () => {
		const outcome = {
			name: "unit",
			argv: ["node", "test.js"],
			passed: false,
			exitCode: 1,
			timedOut: false,
			elapsedMs: 10,
			output: "expected 1",
			truncated: false,
		};
		const plain = formatCheckFeedback([outcome], 2, 2, true, false, true);
		expect(plain).toContain("state the most likely root cause and one alternative explanation");
		const diverged = formatCheckFeedback([outcome], 2, 2, true, false, true, "DIVERGENCE TEXT");
		expect(diverged).toContain("Treat the previous approach as rejected");
		expect(diverged).toContain("DIVERGENCE TEXT");
		expect(diverged).not.toContain("one alternative explanation");
		expect(diverged).toContain("Choose a materially different repair or report the blocker.");
	});
});

describe("test command detection", () => {
	it.each([
		"npm test",
		"npx vitest run",
		"pytest -q",
		"go test ./...",
		"cargo test",
		"node --test test/port.test.js",
		"node test/port.test.mjs",
		"python -m pytest",
		"python3 tests/test_port.py",
		"npx tsc --noEmit",
	])("counts %s as verification", (command) => {
		expect(TEST_COMMAND.test(command)).toBe(true);
	});

	it.each(["ls -la", "cat port.js", "git status", "node build.js", "echo latest"])("does not count %s", (command) => {
		expect(TEST_COMMAND.test(command)).toBe(false);
	});
});
