import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectedSessionEntry } from "../src/core/session-manager.ts";
import { fitCompactionToWindow } from "../src/core/settings-manager.ts";
import { CheckpointStore } from "../src/harness/checkpoints.ts";
import { parseHarnessConfig } from "../src/harness/config.ts";
import { buildContextPack, buildFollowUpPack } from "../src/harness/context-pack.ts";
import { detectProjectChecks, expandTests } from "../src/harness/detect-checks.ts";
import {
	closestBlock,
	editTextFound,
	LoopGuard,
	notFoundHint,
	repairIndentation,
	suggestPaths,
} from "../src/harness/edit-repair.ts";
import { escalationPrompt, formatAdvice, requestAdvice } from "../src/harness/escalate.ts";
import { classifyModel, parseFeatureOverrides, resolveFeatures } from "../src/harness/features.ts";
import { fitMaskingToWindow, planMasking } from "../src/harness/masking.ts";
import { identifierTerms, outlineSource, relativeImports } from "../src/harness/outline.ts";
import { checkSyntax, introducedSyntaxError, pythonInterpreter } from "../src/harness/parse-gate.ts";
import { declarationBody, formatDiagnostics, newErrors, runLookup } from "../src/harness/semantic.ts";
import { buildWorkspaceIndex, isTestPath, rankFiles, relatedFiles, testsFor } from "../src/harness/workspace-index.ts";

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

describe("masking scaled to the window", () => {
	const settings = { enabled: true, keepRecentResults: 6, minResultBytes: 2_000, batchBytes: 48_000 };
	let counter = 0;
	const pair = (bytes: number): ProjectedSessionEntry[] => {
		const id = `c${counter++}`;
		const call = {
			role: "assistant",
			content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } }],
			timestamp: 0,
		};
		const result = {
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text: "line\n".repeat(bytes / 5) }],
			isError: false,
			timestamp: 0,
		};
		return [
			{
				sourceEntry: { type: "message", id: `a-${id}`, parentId: null, timestamp: "", message: call },
				messages: [call],
			},
			{
				sourceEntry: { type: "message", id: `r-${id}`, parentId: null, timestamp: "", message: result },
				messages: [result],
			},
		] as unknown as ProjectedSessionEntry[];
	};

	it("scales thresholds down but never above the configured values", () => {
		expect(fitMaskingToWindow(settings, 8192).batchBytes).toBe(Math.floor(8192 * 4 * 0.15));
		expect(fitMaskingToWindow(settings, 1_000_000).batchBytes).toBe(48_000);
	});

	it("masks in an 8K window where fixed byte thresholds never would", () => {
		const entries = [...pair(6_000), ...pair(6_000), ...pair(6_000)];
		expect(planMasking(entries, settings).edits).toEqual([]);
		const plan = planMasking(entries, settings, 8192);
		expect(plan.edits.length).toBeGreaterThanOrEqual(2);
		expect(JSON.stringify(plan.edits[0].replacement)).toContain("lines");
	});
});

describe("features and model classes", () => {
	it("classifies by list price", () => {
		expect(classifyModel({ cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 } })).toBe("frontier");
		expect(classifyModel({ cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 } })).toBe("fast");
		expect(classifyModel(undefined)).toBe("fast");
	});

	it("resolves class defaults, then config, then environment", () => {
		expect(resolveFeatures("fast", {}, {}).escalation).toBe(true);
		expect(resolveFeatures("frontier", {}, {}).escalation).toBe(false);
		expect(resolveFeatures("fast", { contextPack: false }, {}).contextPack).toBe(false);
		expect(resolveFeatures("fast", { contextPack: false }, { contextPack: true }).contextPack).toBe(true);
		expect(parseFeatureOverrides("-contextPack, +escalation,lookup")).toEqual({
			contextPack: false,
			escalation: true,
			lookup: true,
		});
		expect(() => parseFeatureOverrides("-nope")).toThrow(/unknown feature/);
	});

	it("validates features and escalation in harness.json", () => {
		const config = parseHarnessConfig({
			features: { contextPack: false },
			escalation: { model: "anthropic/claude-opus-5-5", maxCallsPerPrompt: 1 },
			checks: [{ name: "t", command: ["npm", "test"], level: 3 }],
		});
		expect(config.features).toEqual({ contextPack: false });
		expect(config.escalation.maxCallsPerPrompt).toBe(1);
		expect(config.checks[0].level).toBe(3);
		expect(() => parseHarnessConfig({ contract: true })).toThrow(/Unknown key "contract"/);
		expect(() => parseHarnessConfig({ features: { typo: true } })).toThrow(/Unknown feature/);
		expect(() => parseHarnessConfig({ escalation: { model: "opus" } })).toThrow(/provider\/model-id/);
		expect(() => parseHarnessConfig({ checks: [{ name: "t", command: ["x"], level: 4 }] })).toThrow(/1, 2 or 3/);
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
		expect(identifierTerms("parsePortNumber HTTPServer snake_case")).toEqual([
			"parse",
			"port",
			"number",
			"http",
			"server",
			"snake",
			"case",
		]);
	});
});

describe("workspace index and context pack", () => {
	let root: string;
	beforeEach(() => {
		root = tempDir("harness-index-");
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

	it("ranks the file a request names, and pulls in its test", () => {
		const index = buildWorkspaceIndex(root);
		const ranked = rankFiles(index, "parsePort in port.js should only return a valid port");
		expect(ranked[0].file.path).toBe("src/port.js");
		expect(ranked.map((item) => item.file.path)).toContain("test/port.test.js");
		expect(relatedFiles(index, index.byPath.get("src/port.js")!).map((file) => file.path)).toEqual([
			"test/port.test.js",
		]);
		expect(testsFor(index, ["src/port.js"])).toEqual(["test/port.test.js"]);
		expect(isTestPath("test/port.test.js")).toBe(true);
		expect(isTestPath("src/port.js")).toBe(false);
	});

	it("reuses unchanged files when refreshed", () => {
		const first = buildWorkspaceIndex(root);
		const second = buildWorkspaceIndex(root, first);
		expect(second.byPath.get("src/csv.js")).toBe(first.byPath.get("src/csv.js"));
	});

	it("builds a bounded pack with environment, ranked files and inlined contents", () => {
		const index = buildWorkspaceIndex(root);
		const facts = detectProjectChecks(root);
		const pack = buildContextPack({
			index,
			request: "Fix parsePort in port.js",
			facts,
			checks: facts.checks,
			platform: "win32",
			shell: "powershell",
			git: { branch: "main", changed: [] },
			budgetTokens: 2_000,
		});
		expect(pack).toBeDefined();
		expect(pack!.bytes).toBeLessThan(2_000 * 4 + 400);
		expect(pack!.text).toContain("PowerShell syntax");
		expect(pack!.text).toContain("tests: `npm test`");
		expect(pack!.inlined[0]).toBe("src/port.js");
		expect(pack!.text).toContain('<file path="src/port.js">');
		expect(pack!.text).toContain("src/util/strings.js");
		expect(buildFollowUpPack(index, "now the csv parser parseCsvLine")).toContain("src/csv.js");
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

describe("parse gate", () => {
	let root: string;
	beforeEach(() => {
		root = tempDir("harness-parse-");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("checks JSON in process", () => {
		expect(checkSyntax('{"a": 1}', "a.json", root)?.ok).toBe(true);
		expect(checkSyntax('{"a": }', "a.json", root)?.ok).toBe(false);
	});

	it.skipIf(!hasCommand("node"))(
		"rejects a JavaScript edit that breaks parsing, but not a file already broken",
		() => {
			const good = "function a() {\n  return 1;\n}\n";
			const bad = "function a() {\n  return 1;\n";
			expect(checkSyntax(good, "a.js", root)?.ok).toBe(true);
			const error = introducedSyntaxError(good, bad, "a.js", root);
			expect(error?.ok).toBe(false);
			expect(introducedSyntaxError(bad, `${bad}\n`, "a.js", root)).toBeUndefined();
			// A new file counts as valid before.
			expect(introducedSyntaxError(undefined, bad, "a.js", root)?.ok).toBe(false);
		},
	);

	it.skipIf(!pythonInterpreter())("reports the Python syntax error location", () => {
		const result = checkSyntax("def f(:\n  pass\n", "a.py", root);
		expect(result?.ok).toBe(false);
		expect(result?.error).toMatch(/^1:/);
	});

	it("does not check unknown file types", () => {
		expect(checkSyntax("anything", "a.txt", root)).toBeUndefined();
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

describe.skipIf(!hasCommand("git"))("checkpoints", () => {
	let root: string;
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
	beforeEach(() => {
		root = tempDir("harness-ckpt-");
		git("init", "-q");
		writeFileSync(join(root, "a.js"), "one\n");
		git("add", "-A");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("snapshots without touching the index and restores changed, added and deleted files", () => {
		writeFileSync(join(root, "a.js"), "two\n");
		writeFileSync(join(root, "gone.js"), "keep me\n");
		const store = new CheckpointStore(root, "test");
		const checkpoint = store.snapshot("green");
		expect(checkpoint).toBeDefined();
		expect(git("status", "--porcelain")).toContain(" M a.js");
		expect(git("stash", "list")).toBe("");

		writeFileSync(join(root, "a.js"), "three\n");
		writeFileSync(join(root, "new.js"), "new\n");
		rmSync(join(root, "gone.js"));
		const only = ["a.js", "new.js", "gone.js"].map((path) => join(root, path));
		const restored = store.restore(checkpoint!, only);
		expect(restored?.paths.sort()).toEqual([...only].sort());
		expect(restored?.diff).toContain("+three");
		expect(readFileSync(join(root, "a.js"), "utf8")).toBe("two\n");
		expect(() => readFileSync(join(root, "new.js"))).toThrow();
		expect(readFileSync(join(root, "gone.js"), "utf8")).toBe("keep me\n");
		expect(git("for-each-ref", "refs/midnight")).toContain("refs/midnight/checkpoints/test-1");
		store.dispose();
		expect(git("for-each-ref", "refs/midnight")).toBe("");
	});

	it("restores only the given paths and leaves every other change alone", () => {
		const store = new CheckpointStore(root, "test");
		const checkpoint = store.snapshot("green");
		writeFileSync(join(root, "a.js"), "agent change\n");
		writeFileSync(join(root, "notes.txt"), "user notes\n");
		mkdirSync(join(root, "docs"));
		writeFileSync(join(root, "docs", "user.md"), "user doc\n");

		const restored = store.restore(checkpoint!, [join(root, "a.js")]);
		expect(restored?.paths).toEqual([join(root, "a.js")]);
		expect(restored?.diff).toContain("+agent change");
		expect(restored?.diff).not.toContain("user notes");
		expect(readFileSync(join(root, "a.js"), "utf8")).toBe("one\n");
		expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("user notes\n");
		expect(readFileSync(join(root, "docs", "user.md"), "utf8")).toBe("user doc\n");

		// Nothing to restore among the given paths: nothing happens.
		expect(store.restore(checkpoint!, [join(root, "a.js"), join(root, "missing.js")])).toBeUndefined();
		expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("user notes\n");
		expect(store.restore(checkpoint!, [])).toBeUndefined();
		store.dispose();
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

describe("lookup and diagnostics helpers", () => {
	let root: string;
	beforeEach(() => {
		root = tempDir("harness-lookup-");
		writeTree(root, {
			"src/port.ts":
				"export function parsePort(value: string): number {\n  const n = Number(value);\n  return n;\n}\n",
			"src/main.ts": "import { parsePort } from './port';\nconsole.log(parsePort('80'));\n",
			"lib/csv.py":
				"def parse_line(line):\n    parts = line.split(',')\n    return parts\n\ndef other():\n    pass\n",
		});
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("returns definitions with bodies, references and outlines without a language server", async () => {
		const index = buildWorkspaceIndex(root);
		const definition = await runLookup({ op: "definition", symbol: "parsePort" }, index, undefined);
		expect(definition).toContain("src/port.ts:1");
		expect(definition).toContain("3\t  return n;");
		const references = await runLookup({ op: "references", symbol: "parsePort" }, index, undefined);
		expect(references).toContain("src/main.ts:2");
		const outline = await runLookup({ op: "outline", path: "lib/csv.py" }, index, undefined);
		expect(outline).toContain("function parse_line :1");
		expect(await runLookup({ op: "definition", symbol: "nope" }, index, undefined)).toContain("No declaration");
	});

	it("cuts a Python body at the dedent", () => {
		const lines = readFileSync(join(root, "lib/csv.py"), "utf8").split("\n");
		expect(declarationBody(lines, 1)).toBe(
			"1\tdef parse_line(line):\n2\t    parts = line.split(',')\n3\t    return parts",
		);
	});

	it("reports only errors the edit introduced", () => {
		const error = (message: string, line = 0) => ({
			message,
			severity: 1,
			range: { start: { line, character: 0 }, end: { line, character: 1 } },
		});
		const fresh = newErrors([error("old")], [error("old", 3), error("new", 4), { ...error("warn"), severity: 2 }]);
		expect(fresh.map((item) => item.message)).toEqual(["new"]);
		expect(formatDiagnostics("a.ts", fresh, "typescript language server")).toContain("a.ts:5:1: new");
	});
});
