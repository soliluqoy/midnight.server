import { describe, expect, it } from "vitest";
import { compareWithBaseline, errorEntries } from "../src/harness/baseline.ts";
import type { CheckOutcome } from "../src/harness/checks.ts";

function outcome(output: string, exitCode: number | null = 2, options: Partial<CheckOutcome> = {}): CheckOutcome {
	return {
		name: "types",
		argv: ["npx", "tsc", "--noEmit"],
		passed: exitCode === 0,
		exitCode,
		timedOut: false,
		elapsedMs: 1000,
		output,
		truncated: false,
		...options,
	};
}

const OLD = "src/old.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.";
const NEW = "src/new.ts(10,1): error TS2304: Cannot find name 'foo'.";

describe("check baselines", () => {
	it("holds back a failure with only errors the baseline had, even after lines moved", () => {
		const before = outcome(`${OLD}\nFound 1 error in 1 file.`);
		const now = outcome(`${OLD.replace("(3,5)", "(7,5)")}\nFound 1 error in 1 file.`);
		expect(compareWithBaseline(now, before)).toEqual({ preexisting: true, newErrors: [], known: 2 });
	});

	it("reports only the new errors", () => {
		const before = outcome(`${OLD}\nFound 1 error in 1 file.`);
		const now = outcome(`${OLD}\n${NEW}\nFound 2 errors in 2 files.`);
		const comparison = compareWithBaseline(now, before);
		expect(comparison?.preexisting).toBe(false);
		expect(comparison?.newErrors).toEqual([NEW]);
		expect(comparison?.known).toBe(2);
	});

	it("counts a second copy of an existing error as new", () => {
		const before = outcome(OLD);
		const now = outcome(`${OLD}\n${OLD.replace("(3,5)", "(9,5)")}`);
		expect(compareWithBaseline(now, before)?.newErrors).toHaveLength(1);
	});

	it("keys indented errors under their file header (ESLint style)", () => {
		const before = outcome("/repo/a.js\n  3:5  error  'x' is unused  no-unused-vars\n", 1);
		const now = outcome(
			"/repo/a.js\n  4:5  error  'x' is unused  no-unused-vars\n/repo/b.js\n  1:1  error  'x' is unused  no-unused-vars\n",
			1,
		);
		const comparison = compareWithBaseline(now, before);
		expect(comparison?.newErrors).toEqual(["/repo/b.js: 1:1  error  'x' is unused  no-unused-vars"]);
		expect(errorEntries(now.output)).toHaveLength(2);
	});

	it("compares nothing when the baseline passed, timed out or exited differently", () => {
		const now = outcome(NEW);
		expect(compareWithBaseline(now, outcome("", 0))).toBeUndefined();
		expect(compareWithBaseline(now, outcome(NEW, null, { timedOut: true }))).toBeUndefined();
		expect(compareWithBaseline(now, outcome(NEW, 1))).toBeUndefined();
		expect(compareWithBaseline(outcome("", 0), outcome(NEW))).toBeUndefined();
	});

	it("treats unrecognized output as the same failure only when it is identical", () => {
		expect(compareWithBaseline(outcome("boom 12ms"), outcome("boom 40ms"))?.preexisting).toBe(true);
		expect(compareWithBaseline(outcome("boom"), outcome("crash"))).toBeUndefined();
	});
});
