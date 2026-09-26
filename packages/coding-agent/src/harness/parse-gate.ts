import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

/**
 * Syntax checks for edited files, so an edit that breaks a file is caught in the same turn.
 *
 * Problem: a fast model's edit drops a closing brace. Nothing notices until tests run at the
 * end, and by then three more edits sit on top of the broken one. Each later turn pays for
 * the confusion.
 *
 * Solution: after every edit, parse the new content with the language's own parser. If it
 * no longer parses but the old content did, the caller restores the old content and tells
 * the model why, in the same tool result. A file that was already broken is never blocked:
 * the gate only rejects edits that introduce a syntax error.
 *
 * Parsers are the ones the machine already has: the project's own `typescript` for TS/JS,
 * `node --check` for JS without it, Python's `ast`, `gofmt`, `rustfmt`, and JSON.parse.
 * When none is available the file is not checked.
 */

export interface SyntaxResult {
	ok: boolean;
	/** First error, "line:col message" when known. */
	error?: string;
	/** The parser used, for telemetry. */
	parser: string;
}

type Checker = (content: string, path: string, cwd: string) => SyntaxResult | undefined;

const TIMEOUT_MS = 15_000;

const TS_PARSE_SCRIPT = `
const ts = require(process.argv[1]);
let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { text += chunk; });
process.stdin.on("end", () => {
  const file = process.argv[2];
  const kind = /\\.tsx$/i.test(file) ? ts.ScriptKind.TSX : /\\.jsx$/i.test(file) ? ts.ScriptKind.JSX
    : /\\.(js|mjs|cjs)$/i.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = source.parseDiagnostics || [];
  if (diagnostics.length === 0) { process.stdout.write("OK"); return; }
  const d = diagnostics[0];
  const pos = source.getLineAndCharacterOfPosition(d.start || 0);
  process.stdout.write("ERR " + (pos.line + 1) + ":" + (pos.character + 1) + " " + ts.flattenDiagnosticMessageText(d.messageText, " "));
});
`;

function which(command: string): boolean {
	const probe = process.platform === "win32" ? "where" : "which";
	return spawnSync(probe, [command], { stdio: "ignore", windowsHide: true }).status === 0;
}

const available = new Map<string, boolean>();
function has(command: string): boolean {
	let known = available.get(command);
	if (known === undefined) {
		known = which(command);
		available.set(command, known);
	}
	return known;
}

/** The project's own TypeScript compiler module, when it has one. */
function projectTypeScript(cwd: string): string | undefined {
	try {
		return createRequire(join(cwd, "package.json")).resolve("typescript");
	} catch {
		return undefined;
	}
}

function runParser(
	command: string,
	args: string[],
	input: string,
	cwd: string,
): { status: number | null; out: string } {
	const result = spawnSync(command, args, {
		cwd,
		input,
		encoding: "utf8",
		timeout: TIMEOUT_MS,
		windowsHide: true,
		maxBuffer: 4 * 1024 * 1024,
	});
	return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function firstLine(text: string): string {
	return (text.split(/\r?\n/).find((line) => line.trim()) ?? text).trim().slice(0, 300);
}

const typeScriptChecker: Checker = (content, path, cwd) => {
	if (!has("node")) return undefined;
	const tsModule = projectTypeScript(cwd);
	if (tsModule) {
		const { status, out } = runParser("node", ["-e", TS_PARSE_SCRIPT, tsModule, basename(path)], content, cwd);
		if (status !== 0) return undefined;
		return out.startsWith("OK")
			? { ok: true, parser: "typescript" }
			: { ok: false, error: out.slice(4), parser: "typescript" };
	}
	const extension = extname(path).toLowerCase();
	if (![".js", ".mjs", ".cjs"].includes(extension)) return undefined;
	const dir = mkdtempSync(join(tmpdir(), "harness-parse-"));
	try {
		const file = join(dir, `check${extension}`);
		writeFileSync(file, content);
		const { status, out } = runParser("node", ["--check", file], "", dir);
		if (status === null) return undefined;
		if (status === 0) return { ok: true, parser: "node --check" };
		const location = /check\.[a-z]+:(\d+)/.exec(out)?.[1];
		const message = out.split(/\r?\n/).find((line) => /Error/.test(line)) ?? firstLine(out);
		return { ok: false, error: `${location ? `${location}: ` : ""}${message.trim()}`, parser: "node --check" };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

const pythonChecker: Checker = (content, path, cwd) => {
	const python = has("python3") ? "python3" : has("python") ? "python" : undefined;
	if (!python) return undefined;
	const script =
		"import ast,sys\ntry:\n ast.parse(sys.stdin.read(), sys.argv[1])\n print('OK')\nexcept SyntaxError as e:\n print(f'ERR {e.lineno}:{e.offset} {e.msg}')";
	const { status, out } = runParser(python, ["-c", script, basename(path)], content, cwd);
	if (status !== 0) return undefined;
	return out.startsWith("OK")
		? { ok: true, parser: "python ast" }
		: { ok: false, error: out.slice(4), parser: "python ast" };
};

const goChecker: Checker = (content, _path, cwd) => {
	if (!has("gofmt")) return undefined;
	const { status, out } = runParser("gofmt", ["-e"], content, cwd);
	if (status === null) return undefined;
	if (status === 0) return { ok: true, parser: "gofmt" };
	return { ok: false, error: firstLine(out.replace(/^<standard input>:/gm, "")), parser: "gofmt" };
};

const rustChecker: Checker = (content, _path, cwd) => {
	if (!has("rustfmt")) return undefined;
	const { status, out } = runParser("rustfmt", ["--edition", "2021", "--emit", "stdout"], content, cwd);
	if (status === null) return undefined;
	if (status === 0) return { ok: true, parser: "rustfmt" };
	const error = out.split(/\r?\n/).find((line) => line.startsWith("error")) ?? firstLine(out);
	const location = /<stdin>:(\d+:\d+)/.exec(out)?.[1];
	return { ok: false, error: `${location ? `${location} ` : ""}${error}`, parser: "rustfmt" };
};

const jsonChecker: Checker = (content) => {
	try {
		JSON.parse(content);
		return { ok: true, parser: "JSON.parse" };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error), parser: "JSON.parse" };
	}
};

const CHECKERS: Record<string, Checker> = {
	".ts": typeScriptChecker,
	".tsx": typeScriptChecker,
	".mts": typeScriptChecker,
	".cts": typeScriptChecker,
	".js": typeScriptChecker,
	".jsx": typeScriptChecker,
	".mjs": typeScriptChecker,
	".cjs": typeScriptChecker,
	".py": pythonChecker,
	".go": goChecker,
	".rs": rustChecker,
	".json": jsonChecker,
};

export function canCheckSyntax(path: string): boolean {
	return extname(path).toLowerCase() in CHECKERS;
}

/** Parse `content` as the language of `path`. Undefined when no parser is available. */
export function checkSyntax(content: string, path: string, cwd: string): SyntaxResult | undefined {
	const checker = CHECKERS[extname(path).toLowerCase()];
	if (!checker) return undefined;
	try {
		return checker(content, path, cwd);
	} catch {
		return undefined;
	}
}

/**
 * Decide whether an edit from `before` to `after` introduced a syntax error. `before` is
 * undefined for a new file, which counts as valid. Returns the error to report, or undefined
 * when the edit is acceptable (parses, was already broken, or cannot be checked).
 */
export function introducedSyntaxError(
	before: string | undefined,
	after: string,
	path: string,
	cwd: string,
): SyntaxResult | undefined {
	const next = checkSyntax(after, path, cwd);
	if (!next || next.ok) return undefined;
	if (before !== undefined) {
		const previous = checkSyntax(before, path, cwd);
		if (!previous || !previous.ok) return undefined;
	}
	return next;
}
