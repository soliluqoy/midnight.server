import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CHECK_TIMEOUT_MS, type HarnessCheck } from "./config.ts";

/**
 * Find the checks a project already defines, so the harness can verify changes in projects
 * with no `harness.json`. Only commands the project itself declares or clearly implies are
 * used, and the result is ordered as a ladder, cheapest first:
 *
 * 1. types and lint (seconds, catch most broken edits),
 * 2. the tests related to the changed files (`{tests}`),
 * 3. the full test suite.
 *
 * Running project commands executes project code, so the caller only uses this for trusted
 * projects, like `harness.json` itself.
 */

export type LadderLevel = 1 | 2 | 3;

export interface DetectedCheck extends HarnessCheck {
	level: LadderLevel;
	/** Where the check came from, shown in `/harness`. */
	source: string;
	/** `{tests}` in `command` is replaced by related test files; without any, the check is skipped. */
	needsTests?: boolean;
}

export interface ProjectFacts {
	packageManager?: "npm" | "pnpm" | "yarn" | "bun";
	languages: string[];
	testCommand?: string;
	checks: DetectedCheck[];
}

/**
 * Checks a language server also covers (type checkers, compilers): in-run checks skip them for
 * files the server already checked. Configured checks count by name.
 */
const TYPE_CHECK_NAMES = new Set(["types", "typecheck", "type-check", "tsc", "mypy", "pyright", "cargo check"]);

export function isTypeCheck(check: HarnessCheck): boolean {
	return TYPE_CHECK_NAMES.has(check.name.toLowerCase());
}

const LINT_CHECK_NAMES = new Set(["lint", "vet", "eslint", "ruff", "biome", "clippy", "flake8", "pylint"]);

/**
 * Static checks (types, lint) report on the code as it is, not on what the request asked for, so
 * their failures before a request can be held back (baseline.ts). A test check is never one: a
 * failing test at the start is often the request itself.
 */
export function isStaticCheck(check: HarnessCheck): boolean {
	return isTypeCheck(check) || LINT_CHECK_NAMES.has(check.name.toLowerCase());
}

const FIXING_SCRIPT = /--fix\b|--write\b|\bprettier\b.*--write|\bformat\b/;
const PLACEHOLDER_TEST = /no test specified/;

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function packageManager(root: string): "npm" | "pnpm" | "yarn" | "bun" {
	if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(root, "yarn.lock"))) return "yarn";
	if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
	return "npm";
}

function runScript(pm: string, name: string): string[] {
	return pm === "npm" ? ["npm", "run", "--silent", name] : [pm, "run", name];
}

const JS_GLOBS = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"];

function detectNode(root: string, facts: ProjectFacts): void {
	const manifest = readJson(join(root, "package.json"));
	if (!manifest) return;
	facts.languages.push("javascript/typescript");
	const pm = packageManager(root);
	facts.packageManager = pm;
	const scripts = (
		typeof manifest.scripts === "object" && manifest.scripts !== null ? manifest.scripts : {}
	) as Record<string, unknown>;
	const script = (name: string) => (typeof scripts[name] === "string" ? (scripts[name] as string) : undefined);
	const hasBin = (name: string) =>
		existsSync(join(root, "node_modules", ".bin", name)) ||
		existsSync(join(root, "node_modules", ".bin", `${name}.cmd`));

	const typeScript = ["typecheck", "type-check", "check-types", "types", "tsc"].find((name) => script(name));
	if (typeScript && !FIXING_SCRIPT.test(script(typeScript) ?? "")) {
		facts.checks.push({
			name: "types",
			command: runScript(pm, typeScript),
			when: JS_GLOBS,
			timeoutMs: 180_000,
			level: 1,
			source: `package.json scripts.${typeScript}`,
		});
	} else if (existsSync(join(root, "tsconfig.json")) && hasBin("tsc")) {
		facts.checks.push({
			name: "types",
			command: ["npx", "--no-install", "tsc", "--noEmit", "-p", "tsconfig.json"],
			when: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
			timeoutMs: 180_000,
			level: 1,
			source: "tsconfig.json",
		});
	}
	const lint = script("lint");
	if (lint && !FIXING_SCRIPT.test(lint)) {
		facts.checks.push({
			name: "lint",
			command: runScript(pm, "lint"),
			when: JS_GLOBS,
			timeoutMs: 180_000,
			level: 1,
			source: "package.json scripts.lint",
		});
	}
	const test = script("test");
	if (!test || PLACEHOLDER_TEST.test(test)) return;
	facts.testCommand = pm === "npm" ? "npm test" : `${pm} test`;
	const full: DetectedCheck = {
		name: "tests",
		command: pm === "npm" ? ["npm", "test", "--silent"] : [pm, "test"],
		timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
		level: 3,
		source: "package.json scripts.test",
	};
	let related: DetectedCheck | undefined;
	if (/\bvitest\b/.test(test) && hasBin("vitest")) {
		related = { ...full, name: "related tests", command: ["npx", "--no-install", "vitest", "run", "{tests}"] };
	} else if (/\bjest\b/.test(test) && hasBin("jest")) {
		related = { ...full, name: "related tests", command: ["npx", "--no-install", "jest", "{tests}"] };
	} else if (/\bnode\s+--test\b/.test(test)) {
		related = { ...full, name: "related tests", command: ["node", "--test", "{tests}"] };
	}
	if (related) facts.checks.push({ ...related, level: 2, needsTests: true, timeoutMs: 120_000 });
	facts.checks.push(full);
}

function fileContains(path: string, pattern: RegExp): boolean {
	try {
		return pattern.test(readFileSync(path, "utf8"));
	} catch {
		return false;
	}
}

function detectPython(root: string, facts: ProjectFacts, python: string | undefined): void {
	const pyproject = join(root, "pyproject.toml");
	const markers = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "pytest.ini", "tox.ini"];
	if (!markers.some((name) => existsSync(join(root, name)))) return;
	facts.languages.push("python");
	if (!python) return;
	const usesPytest =
		existsSync(join(root, "pytest.ini")) ||
		existsSync(join(root, "conftest.py")) ||
		fileContains(pyproject, /\[tool\.pytest|pytest/) ||
		fileContains(join(root, "setup.cfg"), /\[tool:pytest\]/) ||
		fileContains(join(root, "tox.ini"), /pytest/) ||
		fileContains(join(root, "requirements.txt"), /pytest/) ||
		existsSync(join(root, "tests"));
	if (usesPytest) {
		facts.testCommand = `${python} -m pytest`;
		facts.checks.push({
			name: "related tests",
			command: [python, "-m", "pytest", "-q", "-x", "{tests}"],
			when: ["**/*.py"],
			timeoutMs: 120_000,
			level: 2,
			needsTests: true,
			source: "pytest configuration",
		});
		facts.checks.push({
			name: "tests",
			command: [python, "-m", "pytest", "-q"],
			when: ["**/*.py"],
			timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
			level: 3,
			source: "pytest configuration",
		});
	}
	if (existsSync(join(root, "mypy.ini")) || fileContains(pyproject, /\[tool\.mypy\]/)) {
		facts.checks.push({
			name: "types",
			command: [python, "-m", "mypy", "{files}"],
			when: ["**/*.py"],
			timeoutMs: 180_000,
			level: 1,
			source: "mypy configuration",
		});
	}
}

function detectGo(root: string, facts: ProjectFacts): void {
	if (!existsSync(join(root, "go.mod"))) return;
	facts.languages.push("go");
	facts.testCommand = "go test ./...";
	facts.checks.push(
		{
			name: "vet",
			command: ["go", "vet", "./..."],
			when: ["**/*.go"],
			timeoutMs: 180_000,
			level: 1,
			source: "go.mod",
		},
		{
			name: "tests",
			command: ["go", "test", "./..."],
			when: ["**/*.go"],
			timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
			level: 3,
			source: "go.mod",
		},
	);
}

function detectRust(root: string, facts: ProjectFacts): void {
	if (!existsSync(join(root, "Cargo.toml"))) return;
	facts.languages.push("rust");
	facts.testCommand = "cargo test";
	facts.checks.push(
		{
			name: "cargo check",
			command: ["cargo", "check", "--quiet"],
			when: ["**/*.rs"],
			timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
			level: 1,
			source: "Cargo.toml",
		},
		{
			name: "tests",
			command: ["cargo", "test", "--quiet"],
			when: ["**/*.rs"],
			timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
			level: 3,
			source: "Cargo.toml",
		},
	);
}

/** Detect the project's checks. `python` is the interpreter command found on PATH, if any. */
export function detectProjectChecks(root: string, options: { python?: string } = {}): ProjectFacts {
	const facts: ProjectFacts = { languages: [], checks: [] };
	detectNode(root, facts);
	detectPython(root, facts, options.python);
	detectGo(root, facts);
	detectRust(root, facts);
	for (const check of facts.checks) check.env = { CI: "1", ...check.env };
	return facts;
}

/**
 * Expand `{tests}`: with related tests, into those paths; without, the check is dropped
 * (the full-suite check on the next level covers it).
 */
export function expandTests(
	check: HarnessCheck & { needsTests?: boolean },
	tests: readonly string[],
): string[] | undefined {
	if (!check.command.includes("{tests}")) return check.command;
	if (tests.length === 0) return undefined;
	return check.command.flatMap((arg) => (arg === "{tests}" ? [...tests] : [arg]));
}

export interface EnvironmentInput {
	facts: ProjectFacts;
	/** Checks the harness runs when the model finishes, if any. */
	checks: ReadonlyArray<Pick<DetectedCheck, "name" | "command">>;
	platform: NodeJS.Platform;
	shell: "powershell" | "bash" | undefined;
}

/**
 * The environment facts for the system prompt: stable for a session, so they sit in the cached
 * prompt prefix and cost nothing after the first request.
 */
export function describeEnvironment(input: EnvironmentInput): string {
	const os = input.platform === "win32" ? "Windows" : input.platform === "darwin" ? "macOS" : "Linux";
	const lines = [
		`OS: ${os}${input.shell ? `, shell tool: ${input.shell}${input.shell === "powershell" ? " (PowerShell syntax, not bash)" : ""}` : ""}.`,
	];
	const project: string[] = [];
	if (input.facts.languages.length > 0) project.push(`languages: ${input.facts.languages.join(", ")}`);
	if (input.facts.packageManager) project.push(`package manager: ${input.facts.packageManager}`);
	if (input.facts.testCommand) project.push(`tests: \`${input.facts.testCommand}\``);
	if (project.length > 0) lines.push(`Project: ${project.join("; ")}.`);
	if (input.checks.length > 0) {
		lines.push(
			`When you finish, the harness runs these checks on the files you changed and shows you any failure: ${input.checks.map((check) => check.name).join(", ")}.`,
		);
	}
	return lines.join("\n");
}
