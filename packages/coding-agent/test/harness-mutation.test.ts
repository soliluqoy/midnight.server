import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	candidateMutants,
	changedLines,
	formatProbeFeedback,
	journalName,
	maskLine,
	recoverMutations,
	runProbe,
	selectMutants,
} from "../src/harness/mutation.ts";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "harness-mutation-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("mutant generation", () => {
	it("finds the lines a change added or modified", () => {
		expect(changedLines("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual([2, 4]);
		expect(changedLines(undefined, "x\ny\n")).toEqual([1, 2]);
		expect(changedLines("a\nb\n", "b\n")).toEqual([]);
	});

	it("blanks strings and comments", () => {
		expect(maskLine(`const s = "a < b"; // x > y`, "c")).toBe(`const s = "     ";         `);
		const python = `x = 'a and b'  # c or d`;
		expect(maskLine(python, "python")).toBe(`x = '       '${" ".repeat(python.length - 13)}`);
	});

	it("mutates operators, booleans and constants on changed lines only", () => {
		const before = "function f(n) {\n\treturn n;\n}\n";
		const after = "function f(n) {\n\tif (n < 0 && strict === true) return 1;\n\treturn n;\n}\n";
		const mutants = candidateMutants("f.js", before, after);
		expect(mutants.every((mutant) => mutant.line === 2)).toBe(true);
		const tos = mutants.map((mutant) => mutant.to);
		expect(tos).toContain("if (n <= 0 && strict === true) return 1;");
		expect(tos).toContain("if (n < 0 || strict === true) return 1;");
		expect(tos).toContain("if (n < 0 && strict !== true) return 1;");
		expect(tos).toContain("if (n < 0 && strict === false) return 1;");
		expect(tos).toContain("if (n < 1 && strict === true) return 1;");
		expect(tos).toContain("if (n < 0 && strict === true) return 0;");
		for (const mutant of mutants) expect(mutant.content.split("\n")[1]).toBe(`\t${mutant.to}`);
	});

	it("leaves generics, JSX-like tags, strings, indexes and imports alone", () => {
		const after = [
			'import { a } from "./a.ts";',
			"const list: Array<string> = [];",
			'const label = "a < b";',
			"const first = items[0];",
			"",
		].join("\n");
		expect(candidateMutants("x.ts", "", after)).toEqual([]);
	});

	it("uses Python operators for Python", () => {
		const mutants = candidateMutants("port.py", "", "if n < 0 and strict:\n    raise ValueError(n)\n");
		const tos = mutants.map((mutant) => mutant.to);
		expect(tos).toContain("if n <= 0 and strict:");
		expect(tos).toContain("if n < 0 or strict:");
		expect(candidateMutants("notes.md", "", "a < b\n")).toEqual([]);
	});

	it("spreads the selection over lines before taking a second mutant from any line", () => {
		const after = "a = b < c && d;\ne = f + g;\nh = i === j;\n";
		const selected = selectMutants(candidateMutants("x.js", "", after), 3);
		expect(selected.map((mutant) => mutant.line).sort()).toEqual([1, 2, 3]);
		expect(selected.find((mutant) => mutant.line === 1)?.operator).toBe("relational");
	});
});

/** A project whose test pins `n < 0` exactly at 0 and -1, but checks nothing about `n > 65535`. */
function writeProject(dir: string): { before: string; after: string } {
	const before = "exports.valid = (n) => true;\n";
	const after =
		"exports.valid = (n) => {\n\tif (n < 0) return false;\n\tif (n > 65535) return false;\n\treturn true;\n};\n";
	writeFileSync(join(dir, "port.js"), after);
	writeFileSync(
		join(dir, "test.js"),
		"const { valid } = require('./port.js');\nif (valid(-1) !== false || valid(0) !== true) process.exit(1);\n",
	);
	return { before, after };
}

describe("verifier probe", () => {
	it("reports the mutants the tests miss and restores the file", async () => {
		const dir = tempDir();
		const journalDir = join(dir, "journal");
		const { before, after } = writeProject(dir);
		const mutants = candidateMutants("port.js", before, after).filter((mutant) => mutant.operator === "relational");
		expect(mutants).toHaveLength(2);
		const result = await runProbe({
			cwd: dir,
			journalDir,
			mutants,
			budgetMs: 60_000,
			parses: async () => true,
			runChecks: async () => spawnSync(process.execPath, ["test.js"], { cwd: dir }).status === 0,
		});
		expect(result.ran).toBe(2);
		expect(result.killed).toBe(1);
		expect(result.survivors.map((mutant) => mutant.to)).toEqual(["if (n >= 65535) return false;"]);
		expect(readFileSync(join(dir, "port.js"), "utf8")).toBe(after);
		expect(readdirSync(journalDir)).toEqual([]);
		const text = formatProbeFeedback(result, ["unit"]);
		expect(text).toContain("1 were caught; 1 were not");
		expect(text).toContain(
			"port.js:3 (relational): `if (n > 65535) return false;` -> `if (n >= 65535) return false;`",
		);
	});

	it("drops mutants that do not parse and stops at the budget", async () => {
		const dir = tempDir();
		const { before, after } = writeProject(dir);
		const mutants = candidateMutants("port.js", before, after);
		let runs = 0;
		const result = await runProbe({
			cwd: dir,
			journalDir: join(dir, "journal"),
			mutants,
			budgetMs: 0,
			parses: async (mutant) => mutant.operator !== "constant",
			runChecks: async () => {
				runs++;
				return true;
			},
		});
		expect(result.unparsable).toBe(mutants.filter((mutant) => mutant.operator === "constant").length);
		// The first mutant starts before the budget is checked again; the rest are skipped.
		expect(runs).toBeLessThanOrEqual(1);
		expect(result.ran + result.skipped).toBe(mutants.length - result.unparsable);
		expect(readFileSync(join(dir, "port.js"), "utf8")).toBe(after);
	});

	it("restores the original when a check throws", async () => {
		const dir = tempDir();
		const { before, after } = writeProject(dir);
		const [mutant] = candidateMutants("port.js", before, after);
		await expect(
			runProbe({
				cwd: dir,
				journalDir: join(dir, "journal"),
				mutants: [mutant],
				budgetMs: 60_000,
				parses: async () => true,
				runChecks: async () => {
					throw new Error("runner crashed");
				},
			}),
		).rejects.toThrow("runner crashed");
		expect(readFileSync(join(dir, "port.js"), "utf8")).toBe(after);
	});

	it("recovers a file a crashed probe left mutated, and leaves a file the user changed", () => {
		const dir = tempDir();
		const journalDir = join(dir, "journal");
		mkdirSync(journalDir);
		const { before, after } = writeProject(dir);
		const [mutant] = candidateMutants("port.js", before, after);
		// A probe in a process that died mid-mutant: its journal is written and the mutant is in place.
		const deadPid = 2 ** 22 + 12345;
		const journal = join(journalDir, journalName(dir, deadPid));
		const entry = {
			cwd: dir,
			path: join(dir, "port.js"),
			original: after,
			mutant: mutant.content,
			pid: deadPid,
			createdAt: 0,
		};
		writeFileSync(join(dir, "port.js"), mutant.content);
		writeFileSync(journal, JSON.stringify(entry));
		expect(recoverMutations(journalDir, dir)).toEqual([{ path: join(dir, "port.js"), action: "restored" }]);
		expect(readFileSync(join(dir, "port.js"), "utf8")).toBe(after);
		expect(existsSync(journal)).toBe(false);

		// The user edited the file after the crash: it is left alone.
		writeFileSync(join(dir, "port.js"), "user edit\n");
		writeFileSync(journal, JSON.stringify(entry));
		expect(recoverMutations(journalDir, dir)).toEqual([
			{ path: join(dir, "port.js"), action: "changed since; left alone" },
		]);
		expect(readFileSync(join(dir, "port.js"), "utf8")).toBe("user edit\n");
		expect(existsSync(journal)).toBe(false);

		// A journal of a live process in another session belongs to that session.
		writeFileSync(join(dir, "port.js"), mutant.content);
		const live = join(journalDir, journalName(dir, process.ppid));
		writeFileSync(live, JSON.stringify({ ...entry, pid: process.ppid }));
		expect(recoverMutations(journalDir, dir)).toEqual([]);
		expect(existsSync(live)).toBe(true);
	});
});
