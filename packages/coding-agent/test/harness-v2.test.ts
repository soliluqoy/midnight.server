import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fitCompactionToWindow } from "../src/core/settings-manager.ts";
import { filesForCheck, formatCheckSummary, runCheck } from "../src/harness/checks.ts";
import { parseHarnessConfig } from "../src/harness/config.ts";
import { describeEnvironment, detectProjectChecks, expandTests, isTypeCheck } from "../src/harness/detect-checks.ts";
import {
	closestBlock,
	editTextFound,
	LoopGuard,
	notFoundHint,
	repairIndentation,
	suggestPaths,
} from "../src/harness/edit-repair.ts";
import { escalationPrompt, formatAdvice, requestAdvice } from "../src/harness/escalate.ts";
import { DEFAULT_FEATURES, parseFeatureOverrides, resolveFeatures } from "../src/harness/features.ts";
import { materializeTree, workingTreeChanges, writeWorkingTree } from "../src/harness/git.ts";
import { outlineSource, relativeImports } from "../src/harness/outline.ts";
import { checkSyntax, introducedSyntaxError, pythonInterpreter } from "../src/harness/parse-gate.ts";
import { isTestPath, isUnindexableRoot, listWorkspaceFiles, testsFor } from "../src/harness/workspace.ts";

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function writeTree(root: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

function hasCommand(command: string): boolean {
	return spawnSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" }).status === 0;
}

describe("compaction settings fit the context window", () => {
	it("leaves settings that fit a large window unchanged", () => {
		const settings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
		expect(fitCompactionToWindow(settings, 200_000)).toBe(settings);
		expect(fitCompactionToWindow(settings, undefined)).toBe(settings);
	});

	it("shrinks defaults that cannot work in an 8K window so compaction frees room", () => {
		const fitted = fitCompactionToWindow({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }, 8192);
		expect(fitted.reserveTokens).toBe(2048);
		expect(fitted.keepRecentTokens).toBe(3072);
		expect(fitted.keepRecentTokens).toBeLessThan(8192 - fitted.reserveTokens);
	});

	it("fixes a keep value at or above the threshold in a mid-size window", () => {
		const fitted = fitCompactionToWindow({ reserveTokens: 16384, keepRecentTokens: 20000 }, 32_768);
		expect(fitted.reserveTokens).toBe(8192);
		expect(fitted.keepRecentTokens).toBe(12288);
	});
});

describe("features", () => {
	it("keeps everything that costs turns, processes or a second model off by default", () => {
		const on = Object.entries(DEFAULT_FEATURES)
			.filter(([, enabled]) => enabled)
			.map(([name]) => name);
		expect(on).toEqual([
			"parseGate",
			"editRepair",
			"pathHints",
			"loopGuard",
			"checkBaseline",
			"driftGuard",
			"blockerExit",
		]);
	});

	it("resolves defaults, then config, then environment", () => {
		expect(resolveFeatures({}, {}).escalation).toBe(false);
		expect(resolveFeatures({ escalation: true }, {}).escalation).toBe(true);
		expect(resolveFeatures({ escalation: true }, { escalation: false }).escalation).toBe(false);
		expect(parseFeatureOverrides("-driftGuard, +escalation,parseGate")).toEqual({
			driftGuard: false,
			escalation: true,
			parseGate: true,
		});
		expect(() => parseFeatureOverrides("+contextPack")).toThrow(/unknown feature/);
		expect(() => parseFeatureOverrides("-nope")).toThrow(/unknown feature/);
	});

	it("validates features and escalation in harness.json", () => {
		const config = parseHarnessConfig({
			features: { driftGuard: false },
			escalation: { model: "anthropic/claude-opus-5-5", maxCallsPerPrompt: 1 },
			checks: [{ name: "t", command: ["npm", "test"], level: 3 }],
		});
		expect(config.features).toEqual({ driftGuard: false });
		expect(config.escalation.maxCallsPerPrompt).toBe(1);
		expect(config.checks[0].level).toBe(3);
		expect(() => parseHarnessConfig({ contract: true })).toThrow(/Unknown key "contract"/);
		expect(() => parseHarnessConfig({ features: { typo: true } })).toThrow(/Unknown feature/);
		expect(() => parseHarnessConfig({ escalation: { model: "opus" } })).toThrow(/provider\/model-id/);
		expect(() => parseHarnessConfig({ checks: [{ name: "t", command: ["x"], level: 4 }] })).toThrow(/1, 2 or 3/);
	});

	it("accepts a check directory inside the workspace and rejects unknown check keys", () => {
		const config = parseHarnessConfig({ checks: [{ name: "t", command: ["npm", "test"], cwd: "./packages\\ai/" }] });
		expect(config.checks[0].cwd).toBe("packages/ai");
		for (const cwd of ["../elsewhere", "/abs", "C:/abs", ""]) {
			expect(() => parseHarnessConfig({ checks: [{ name: "t", command: ["x"], cwd }] })).toThrow(/cwd/);
		}
		// A typo such as "comand" or "level " must not silently drop the setting.
		expect(() => parseHarnessConfig({ checks: [{ name: "t", command: ["x"], levels: 2 }] })).toThrow(
			/Unknown key "checks\[0\]\.levels"/,
		);
	});
});

describe("outlines", () => {
	it("finds TypeScript declarations and class methods", () => {
		const symbols = outlineSource(
			"a.ts",
			[
				"import { x } from './x';",
				"export const DEFAULT_PORT = 8080;",
				"export function parsePort(value: string): number {",
				"  if (value) {",
				"    return 1;",
				"  }",
				"}",
				"export class Server {",
				"  private port = 1;",
				"  async listen(port: number): Promise<void> {",
				"    await this.bind(port);",
				"  }",
				"  close() {}",
				"}",
				"export interface Options { port: number }",
			].join("\n"),
		);
		expect(
			symbols.map(
				(symbol) => `${symbol.kind}:${symbol.name}:${symbol.line}${symbol.parent ? `@${symbol.parent}` : ""}`,
			),
		).toEqual([
			"variable:DEFAULT_PORT:2",
			"function:parsePort:3",
			"class:Server:8",
			"method:listen:10@Server",
			"method:close:13@Server",
			"type:Options:15",
		]);
	});

	it("finds Python, Go and Rust declarations", () => {
		expect(
			outlineSource(
				"a.py",
				"MAX = 3\nclass Csv:\n    def parse(self, line):\n        pass\ndef main():\n    pass\n",
			).map((s) => s.name),
		).toEqual(["MAX", "Csv", "parse", "main"]);
		expect(
			outlineSource("a.go", "package x\nfunc (s *S) Run() {}\nfunc Parse(v string) int {}\ntype S struct{}\n").map(
				(s) => s.name,
			),
		).toEqual(["Run", "Parse", "S"]);
		expect(
			outlineSource("a.rs", "pub struct P;\nimpl P {\n    pub fn new() -> Self { P }\n}\nfn main() {}\n").map(
				(s) => s.name,
			),
		).toEqual(["P", "P", "new", "main"]);
	});

	it("extracts relative imports and identifier terms", () => {
		expect(
			relativeImports(
				"a.ts",
				"import { a } from './port.js';\nconst b = require('../lib/b');\nimport x from 'react';",
			),
		).toEqual(["./port.js", "../lib/b"]);
	});
});

describe("workspace files and related tests", () => {
	let root: string;
	beforeEach(() => {
		root = tempDir("harness-workspace-");
		writeTree(root, {
			"package.json": JSON.stringify({ scripts: { test: "node --test", lint: "eslint . --fix" } }),
			"src/port.js":
				"export const DEFAULT_PORT = 80;\nexport function parsePort(value) {\n  return Number(value);\n}\n",
			"src/csv.js": "export function parseCsvLine(line) {\n  return line.split(',');\n}\n",
			"src/util/strings.js": "export function pad(value) {\n  return value;\n}\n",
			"test/port.test.js": "import { parsePort } from '../src/port.js';\n",
			"README.md": "# demo\n",
		});
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("finds a changed file's tests by stem and by import", async () => {
		writeTree(root, { "test/strings-check.test.js": "import { pad } from '../src/util/strings.js';\n" });
		const { files } = await listWorkspaceFiles(root);
		expect(files).toContain("src/port.js");
		expect(await testsFor(root, files, ["src/port.js"])).toEqual(["test/port.test.js"]);
		expect(await testsFor(root, files, ["src/util/strings.js"])).toEqual(["test/strings-check.test.js"]);
		expect(await testsFor(root, files, ["test/port.test.js", "README.md"])).toEqual(["test/port.test.js"]);
		expect(await testsFor(root, files, ["src/csv.js"])).toEqual([]);
		expect(isTestPath("test/port.test.js")).toBe(true);
		expect(isTestPath("src/port.js")).toBe(false);
	});

	it("does not run helpers and scripts beside named tests", async () => {
		// packages/tui/test/key-tester.ts imports the changed source but waits for keyboard input, so
		// `node --test` on it never finished and the related-tests check timed out.
		writeTree(root, {
			"test/key-tester.js": "import { parsePort } from '../src/port.js';\n",
			"test/fixture.js": "import { pad } from '../src/util/strings.js';\n",
			"test/strings.test.js": "import { pad } from './fixture.js';\n",
			"legacy/test/csv.js": "import { parseCsvLine } from '../../src/csv.js';\n",
		});
		const { files } = await listWorkspaceFiles(root);
		expect(await testsFor(root, files, ["src/port.js"])).toEqual(["test/port.test.js"]);
		// A changed helper selects the tests that import it, not itself.
		expect(await testsFor(root, files, ["test/fixture.js"])).toEqual(["test/strings.test.js"]);
		// Without named tests in the directory, every file there is a test.
		expect(await testsFor(root, files, ["src/csv.js"])).toEqual(["legacy/test/csv.js"]);
	});

	it("does not index the home directory or a filesystem root", async () => {
		expect(isUnindexableRoot(homedir())).toBe(true);
		expect(isUnindexableRoot(parse(root).root)).toBe(true);
		expect(isUnindexableRoot(root)).toBe(false);
		expect((await listWorkspaceFiles(homedir())).files).toEqual([]);
	});

	it("describes the environment for the system prompt", () => {
		const facts = detectProjectChecks(root);
		const text = describeEnvironment({ facts, checks: facts.checks, platform: "win32", shell: "powershell" });
		expect(text).toContain("PowerShell syntax");
		expect(text).toContain("tests: `npm test`");
		expect(text).toContain("When you finish, the harness runs these checks");
	});
});

describe("check detection", () => {
	let root: string;
	beforeEach(() => {
		root = tempDir("harness-detect-");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("finds node checks as a ladder and skips fixing scripts and placeholder tests", () => {
		writeTree(root, {
			"package.json": JSON.stringify({
				scripts: { typecheck: "tsc --noEmit", lint: "biome check --write .", test: "vitest --run" },
			}),
			"node_modules/.bin/vitest": "",
			"pnpm-lock.yaml": "",
		});
		const facts = detectProjectChecks(root);
		expect(facts.packageManager).toBe("pnpm");
		expect(facts.checks.map((check) => `${check.level}:${check.name}`)).toEqual([
			"1:types",
			"2:related tests",
			"3:tests",
		]);
		expect(facts.checks[0].command).toEqual(["pnpm", "run", "typecheck"]);
		expect(facts.checks[1].command).toEqual(["npx", "--no-install", "vitest", "run", "{tests}"]);
		expect(facts.checks.every((check) => check.env?.CI === "1")).toBe(true);
		// A language server covers the types check during a run; the tests are not covered.
		expect(facts.checks.map((check) => isTypeCheck(check))).toEqual([true, false, false]);
		expect(expandTests(facts.checks[1], ["a.test.ts"])).toEqual([
			"npx",
			"--no-install",
			"vitest",
			"run",
			"a.test.ts",
		]);
		expect(expandTests(facts.checks[1], [])).toBeUndefined();

		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
		);
		expect(detectProjectChecks(root).checks).toEqual([]);
	});

	it("finds related tests per package in a monorepo whose root test script delegates", () => {
		writeTree(root, {
			"package.json": JSON.stringify({
				workspaces: ["packages/*", "tools/cli", "!packages/ignored"],
				scripts: { test: "npm run test --workspaces --if-present" },
			}),
			"node_modules/.bin/vitest": "",
			"packages/a/package.json": JSON.stringify({ scripts: { test: "vitest --run" } }),
			"packages/b/package.json": JSON.stringify({ scripts: { test: "node --test test/*.test.ts" } }),
			"packages/c/package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
			"packages/d/package.json": JSON.stringify({ scripts: { test: "vitest run --config vitest.unit.ts" } }),
			"tools/cli/package.json": JSON.stringify({ scripts: { test: "jest" } }),
		});
		const related = detectProjectChecks(root).checks.filter((check) => check.level === 2);
		expect(related.map((check) => [check.cwd, check.command, check.when])).toEqual([
			["packages/a", ["npx", "--no-install", "vitest", "run", "{tests}"], ["packages/a/**"]],
			["packages/b", ["node", "--test", "{tests}"], ["packages/b/**"]],
			[
				"packages/d",
				["npx", "--no-install", "vitest", "run", "--config", "vitest.unit.ts", "{tests}"],
				["packages/d/**"],
			],
		]);
		// jest is not installed anywhere: no check for tools/cli.
		writeTree(root, { "tools/cli/node_modules/.bin/jest": "" });
		expect(detectProjectChecks(root).checks.some((check) => check.cwd === "tools/cli")).toBe(true);
		// The environment line names the check once, not once per package.
		expect(
			describeEnvironment({ facts: detectProjectChecks(root), checks: related, platform: "linux", shell: "bash" }),
		).toContain("shows you any failure: related tests.");
	});

	it("finds pnpm workspace packages", () => {
		writeTree(root, {
			"package.json": JSON.stringify({ scripts: { test: "pnpm -r test" } }),
			"pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  # comment\n  - \"libs/core\"\n",
			"node_modules/.bin/vitest": "",
			"apps/web/package.json": JSON.stringify({ scripts: { test: "vitest" } }),
			"libs/core/package.json": JSON.stringify({ scripts: { test: "vitest" } }),
		});
		expect(
			detectProjectChecks(root)
				.checks.filter((check) => check.level === 2)
				.map((check) => check.cwd),
		).toEqual(["apps/web", "libs/core"]);
	});

	it("runs a check in its directory with paths relative to it", async () => {
		writeTree(root, { "packages/a/marker.txt": "x" });
		const check = {
			name: "ls",
			command: [
				process.execPath,
				"-e",
				"process.exit(require('fs').existsSync(process.argv[1]) ? 0 : 3)",
				"{files}",
			],
			cwd: "packages/a",
			timeoutMs: 10_000,
		};
		expect(filesForCheck(check, ["packages/a/marker.txt", "packages/b/x.ts", "packages/ab/y.ts"])).toEqual([
			"marker.txt",
		]);
		const outcome = await runCheck({ check, files: ["packages/a/marker.txt"] }, root, new AbortController().signal);
		expect(outcome.passed).toBe(true);
		expect(outcome.argv.at(-1)).toBe("marker.txt");
		expect(formatCheckSummary([outcome])).toContain("marker.txt in packages/a (");
	});

	it("finds pytest, go and cargo checks", () => {
		writeTree(root, {
			"pyproject.toml": "[tool.pytest.ini_options]\n",
			"go.mod": "module x\n",
			"Cargo.toml": "[package]\n",
		});
		const facts = detectProjectChecks(root, { python: "python3" });
		expect(facts.languages).toEqual(["python", "go", "rust"]);
		expect(facts.checks.map((check) => check.name)).toEqual([
			"related tests",
			"tests",
			"vet",
			"tests",
			"cargo check",
			"tests",
		]);
	});
});

const python = await pythonInterpreter();

describe("parse gate", () => {
	let root: string;
	beforeEach(() => {
		root = tempDir("harness-parse-");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("checks JSON in process", async () => {
		expect((await checkSyntax('{"a": 1}', "a.json", root))?.ok).toBe(true);
		expect((await checkSyntax('{"a": }', "a.json", root))?.ok).toBe(false);
	});

	it.skipIf(!hasCommand("node"))(
		"rejects a JavaScript edit that breaks parsing, but not a file already broken",
		async () => {
			const good = "function a() {\n  return 1;\n}\n";
			const bad = "function a() {\n  return 1;\n";
			expect((await checkSyntax(good, "a.js", root))?.ok).toBe(true);
			const error = await introducedSyntaxError(good, bad, "a.js", root);
			expect(error?.ok).toBe(false);
			expect(await introducedSyntaxError(bad, `${bad}\n`, "a.js", root)).toBeUndefined();
			// A new file counts as valid before.
			expect((await introducedSyntaxError(undefined, bad, "a.js", root))?.ok).toBe(false);
		},
	);

	it.skipIf(!python)("reports the Python syntax error location", async () => {
		const result = await checkSyntax("def f(:\n  pass\n", "a.py", root);
		expect(result?.ok).toBe(false);
		expect(result?.error).toMatch(/^1:/);
	});

	it("does not check unknown file types", async () => {
		expect(await checkSyntax("anything", "a.txt", root)).toBeUndefined();
	});
});

describe("edit repair", () => {
	const file = ["class A {", "\tparse(line) {", "\t\treturn line.split(',');", "\t}", "}"].join("\n");

	it("repairs an oldText that differs only in indentation and shifts newText", () => {
		const repaired = repairIndentation(file, {
			oldText: "  parse(line) {\n    return line.split(',');",
			newText: "  parse(line) {\n    return splitCsv(line);",
		});
		expect(repaired).toEqual({
			oldText: "\tparse(line) {\n\t\treturn line.split(',');",
			newText: "\tparse(line) {\n\t\treturn splitCsv(line);",
		});
	});

	it("leaves exact, ambiguous and missing matches alone", () => {
		expect(repairIndentation(file, { oldText: "\tparse(line) {", newText: "x" })).toBeUndefined();
		expect(repairIndentation("a\n  x\n  x\n", { oldText: "x", newText: "y" })).toBeUndefined();
		expect(repairIndentation(file, { oldText: "nothing like it", newText: "y" })).toBeUndefined();
		expect(editTextFound(file, "return line.split(',');   ")).toBe(true);
	});

	it("points to the closest block when text differs", () => {
		const block = closestBlock(file, "parse(line) {\n  return line.split(';');");
		expect(block?.startLine).toBe(2);
		expect(notFoundHint("a.js", file, "parse(line) {\n  return line.split(';');")).toContain("lines 2-3");
		expect(closestBlock(file, "completely unrelated words here")).toBeUndefined();
	});

	it("suggests likely paths", () => {
		const files = ["src/math.js", "src/maths.ts", "test/math.test.js", "README.md"];
		expect(suggestPaths("math.js", files)).toEqual(["src/math.js", "src/maths.ts"]);
		expect(suggestPaths("/workspace/src/math.js", files)[0]).toBe("src/math.js");
		expect(suggestPaths("nothing.py", files)).toEqual([]);
	});

	it("notices repeated calls and repeated failures, and resets on change", () => {
		const guard = new LoopGuard();
		expect(guard.call("read", { path: "a" })).toBeUndefined();
		expect(guard.call("read", { path: "a" })).toContain("call 2");
		guard.noteChange();
		expect(guard.call("read", { path: "a" })).toBeUndefined();
		expect(guard.failure("npm test", "FAIL add: expected 3, got 4 (12 ms)")).toBeUndefined();
		// The same error, with only timings and the truncation note differing, is a repeat.
		expect(
			guard.failure(
				"npm test",
				"FAIL add: expected 3, got 4 (15 ms)\n\n[Showing lines 1-1 of 1. Full output: /tmp/midnight-server-bash-a1b2.log]",
			),
		).toContain("failed 2 times");
		expect(guard.loops).toBe(2);
	});

	it("does not count a fix-and-retest cycle as a loop", () => {
		const guard = new LoopGuard();
		for (let round = 0; round < 4; round++) {
			expect(guard.failure("npm test", "FAIL add: expected 3, got 4")).toBeUndefined();
			guard.noteChange();
		}
		// A different error each time means the model is making progress.
		expect(guard.failure("npm test", "FAIL add: expected 3, got 4")).toBeUndefined();
		expect(guard.failure("npm test", "FAIL sub: expected 1, got 2")).toBeUndefined();
		expect(guard.failure("npm test", "SyntaxError: Unexpected token")).toBeUndefined();
		expect(guard.loops).toBe(0);
	});

	it("does not treat repeated shell commands or re-reads of masked results as loops", () => {
		const guard = new LoopGuard();
		expect(guard.call("bash", { command: "git status" })).toBeUndefined();
		expect(guard.call("bash", { command: "git status" })).toBeUndefined();
		expect(guard.call("read", { path: "big.ts" })).toBeUndefined();
		guard.forgetCalls();
		expect(guard.call("read", { path: "big.ts" })).toBeUndefined();
		expect(guard.loops).toBe(0);
	});
});

describe.skipIf(!hasCommand("git"))("git helpers", () => {
	let root: string;
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
	beforeEach(() => {
		root = tempDir("harness-git-");
		git("init", "-q");
		writeFileSync(join(root, "a.js"), "one\n");
		writeFileSync(join(root, ".gitignore"), "deps/\n.env\n");
		git("add", "-A");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("materializes a start tree with ignored files from the checkout and removes it cleanly", async () => {
		mkdirSync(join(root, "deps"));
		writeFileSync(join(root, "deps", "lib.js"), "dep\n");
		writeFileSync(join(root, ".env"), "KEY=1\n");
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "sub", "b.js"), "b\n");
		const tree = await writeWorkingTree(join(root, "sub"));
		expect(tree).toBeDefined();
		writeFileSync(join(root, "a.js"), "changed\n");

		const copy = await materializeTree(join(root, "sub"), tree!);
		expect(copy).toBeDefined();
		expect(copy!.cwd).toBe(join(copy!.root, "sub"));
		// Tracked files are checked out as git would in the real checkout (CRLF with autocrlf on Windows).
		const text = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
		expect(text(join(copy!.root, "a.js"))).toBe("one\n");
		expect(text(join(copy!.cwd, "b.js"))).toBe("b\n");
		expect(readFileSync(join(copy!.root, "deps", "lib.js"), "utf8")).toBe("dep\n");
		expect(readFileSync(join(copy!.root, ".env"), "utf8")).toBe("KEY=1\n");
		await copy!.dispose();
		expect(existsSync(copy!.root)).toBe(false);
		// The linked directory is removed as a link: its target is intact.
		expect(readFileSync(join(root, "deps", "lib.js"), "utf8")).toBe("dep\n");
		expect(git("status", "--porcelain")).toContain(" M a.js");
	});

	it("inventories changed files with both contents, leaving out binary and oversized ones", async () => {
		writeFileSync(join(root, "gone.js"), "bye\n");
		writeFileSync(join(root, "image.bin"), Buffer.from([1, 0, 2]));
		writeFileSync(join(root, "big.txt"), "x\n");
		const base = await writeWorkingTree(root);
		expect(base).toBeDefined();
		expect(await workingTreeChanges(root, base!)).toEqual([]);

		writeFileSync(join(root, "a.js"), "two\n");
		writeFileSync(join(root, "new file.js"), "new\n");
		rmSync(join(root, "gone.js"));
		writeFileSync(join(root, "image.bin"), Buffer.from([3, 0, 4]));
		writeFileSync(join(root, "big.txt"), "x".repeat(600_000));
		const changes = await workingTreeChanges(root, base!);
		expect(changes?.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
			{ path: "a.js", before: "one\n", after: "two\n" },
			{ path: "gone.js", before: "bye\n", after: undefined },
			{ path: "new file.js", before: undefined, after: "new\n" },
		]);
		// The user's index is untouched.
		expect(git("status", "--porcelain")).toContain(" M a.js");
	});
});

describe("escalation", () => {
	it("builds a bounded handoff and returns the advice with its cost", async () => {
		const prompt = escalationPrompt({
			request: "fix it",
			diff: "x".repeat(20_000),
			failure: "tests fail",
			relevantFiles: ["a.js"],
		});
		expect(prompt).toContain("<request>\nfix it");
		expect(prompt).toContain("[... truncated ...]");
		const advice = await requestAdvice(
			async () =>
				({
					role: "assistant",
					content: [{ type: "text", text: "The root cause is X." }],
					stopReason: "stop",
					usage: { input: 100, output: 10, cost: { total: 0.01 } },
				}) as unknown as AssistantMessage,
			{ request: "r", diff: "", failure: "f", relevantFiles: [] },
			new AbortController().signal,
		);
		expect(advice).toMatchObject({ text: "The root cause is X.", costUsd: 0.01 });
		expect(formatAdvice("anthropic/claude-opus-5-5", advice!)).toContain("Advice from anthropic/claude-opus-5-5");
	});
});
