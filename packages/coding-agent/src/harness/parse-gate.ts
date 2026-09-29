import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";

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
 * Node's own parser for JS without it, Python's `ast` (see `pythonInterpreter`), `gofmt`,
 * `rustfmt`, and JSON.parse. When none is available the file is not checked.
 *
 * Starting node and loading typescript takes most of a second on Windows, and this runs after
 * every edit. So Node and Python parse in one long-lived worker process each, started on first
 * use and stopped after a minute idle: after the first edit a check takes milliseconds.
 */

export interface SyntaxResult {
	ok: boolean;
	/** First error, "line:col message" when known. */
	error?: string;
	/** The parser used, for telemetry. */
	parser: string;
}

type Checker = (content: string, path: string, cwd: string) => Promise<SyntaxResult | undefined>;

const TIMEOUT_MS = 15_000;
const IDLE_MS = 60_000;

/**
 * Node worker. Each stdin line is `{id, text, file, module?}`; each stdout line is `{id, out}` with
 * `out` "OK", "ERR <location> <message>", or null when it could not check. With `module` (the
 * project's typescript) it parses as TS/JS; without, as CommonJS or an ES module, whichever parses.
 */
const NODE_WORKER = `
const vm = require("node:vm");
const modules = new Map();
function location(error) {
  const match = /:(\\d+)(?::(\\d+))?\\s*$/m.exec(String(error.stack).split("\\n")[0]);
  return match ? match[1] + (match[2] ? ":" + match[2] + " " : ": ") : "";
}
function parseTs(module, text, file) {
  let ts = modules.get(module);
  if (!ts) { ts = require(module); modules.set(module, ts); }
  // TypeScript 7 (the native compiler) has no parser API in its main export: parse JS with Node.
  if (typeof ts.createSourceFile !== "function") return /\\.(js|mjs|cjs)$/i.test(file) ? parseJs(text, file) : null;
  const kind = /\\.tsx$/i.test(file) ? ts.ScriptKind.TSX : /\\.jsx$/i.test(file) ? ts.ScriptKind.JSX
    : /\\.(js|mjs|cjs)$/i.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = source.parseDiagnostics || [];
  if (diagnostics.length === 0) return "OK";
  const d = diagnostics[0];
  const pos = source.getLineAndCharacterOfPosition(d.start || 0);
  return "ERR " + (pos.line + 1) + ":" + (pos.character + 1) + " " + ts.flattenDiagnosticMessageText(d.messageText, " ");
}
function parseJs(text, file) {
  const errors = [];
  if (!/\\.mjs$/i.test(file)) {
    try { vm.compileFunction(text, ["exports", "require", "module", "__filename", "__dirname"], { filename: "check" }); return "OK"; }
    catch (error) { errors.push(error); }
  }
  if (!/\\.cjs$/i.test(file)) {
    try { new vm.SourceTextModule(text, { identifier: "check" }); return "OK"; }
    catch (error) { errors.push(error); }
  }
  const error = /^\\s*(import|export)\\b/m.test(text) ? errors[errors.length - 1] : errors[0];
  return "ERR " + location(error) + error.message;
}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let id = null, out = null;
  try {
    const request = JSON.parse(line);
    id = request.id;
    out = request.module ? parseTs(request.module, request.text, request.file) : parseJs(request.text, request.file);
  } catch {}
  process.stdout.write(JSON.stringify({ id, out }) + "\\n");
}).on("close", () => process.exit(0));
`;

/** Python worker: the same line protocol, parsing with `ast`. */
const PYTHON_WORKER = `
import ast, json, sys
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
while True:
    line = sys.stdin.readline()
    if not line:
        break
    request, out = {}, None
    try:
        request = json.loads(line)
        try:
            ast.parse(request["text"], request["file"])
            out = "OK"
        except SyntaxError as e:
            out = f"ERR {e.lineno}:{e.offset} {e.msg}"
    except Exception:
        pass
    sys.stdout.write(json.dumps({"id": request.get("id"), "out": out}) + "\\n")
    sys.stdout.flush()
`;

/**
 * One long-lived parser process. Requests are answered in order; a timeout, crash or failed start
 * answers every pending request with undefined, and the next request starts a fresh process.
 */
class ParserWorker {
	private child: ChildProcess | undefined;
	private readonly pending = new Map<number, (out: string | undefined) => void>();
	private nextId = 0;
	private idle: NodeJS.Timeout | undefined;
	private readonly command: string;
	private readonly args: string[];

	constructor(command: string, args: string[]) {
		this.command = command;
		this.args = args;
	}

	parse(request: { text: string; file: string; module?: string }): Promise<string | undefined> {
		const child = this.start();
		if (!child?.stdin) return Promise.resolve(undefined);
		const id = this.nextId++;
		return new Promise((done) => {
			const timer = setTimeout(() => this.stop(), TIMEOUT_MS);
			this.pending.set(id, (out) => {
				clearTimeout(timer);
				done(out);
			});
			child.stdin?.write(`${JSON.stringify({ id, ...request })}\n`);
		});
	}

	stop(): void {
		const child = this.child;
		this.child = undefined;
		if (this.idle) clearTimeout(this.idle);
		child?.kill();
		for (const done of this.pending.values()) done(undefined);
		this.pending.clear();
	}

	private start(): ChildProcess | undefined {
		if (this.idle) clearTimeout(this.idle);
		this.idle = setTimeout(() => this.stop(), IDLE_MS);
		this.idle.unref();
		if (this.child) return this.child;
		let child: ChildProcess;
		try {
			child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
		} catch {
			return undefined;
		}
		this.child = child;
		// An idle worker must not keep the process alive; a pending request's timer does.
		child.unref();
		for (const stream of [child.stdin, child.stdout]) (stream as { unref?: () => void } | null)?.unref?.();
		child.stdin?.on("error", () => undefined);
		child.on("error", () => {
			if (this.child === child) this.stop();
		});
		child.on("exit", () => {
			if (this.child === child) this.stop();
		});
		if (child.stdout) {
			createInterface({ input: child.stdout }).on("line", (line) => {
				let reply: { id?: unknown; out?: unknown };
				try {
					reply = JSON.parse(line) as { id?: unknown; out?: unknown };
				} catch {
					return;
				}
				if (typeof reply.id !== "number") return;
				const done = this.pending.get(reply.id);
				this.pending.delete(reply.id);
				done?.(typeof reply.out === "string" ? reply.out : undefined);
			});
		}
		return child;
	}
}

let nodeWorker: ParserWorker | undefined;
let pythonWorker: ParserWorker | undefined;

/** Stop the parser workers (session shutdown). The next check starts them again. */
export function disposeParsers(): void {
	nodeWorker?.stop();
	pythonWorker?.stop();
}

function runParser(
	command: string,
	args: string[],
	input: string,
	cwd: string,
): Promise<{ status: number | null; out: string }> {
	return new Promise((done) => {
		const child = execFile(
			command,
			args,
			{ cwd, encoding: "utf8", timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				// Killed by the timeout or never started (ENOENT): no exit status.
				const status = !error ? 0 : typeof error.code === "number" ? error.code : null;
				done({ status, out: `${stdout ?? ""}${stderr ?? ""}`.trim() });
			},
		);
		// A process that exits before reading its input closes the pipe; its exit status tells.
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(input);
	});
}

const available = new Map<string, Promise<boolean>>();
function has(command: string): Promise<boolean> {
	let known = available.get(command);
	if (known === undefined) {
		const probe = process.platform === "win32" ? "where" : "which";
		known = runParser(probe, [command], "", process.cwd()).then(({ status }) => status === 0);
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

function firstLine(text: string): string {
	return (text.split(/\r?\n/).find((line) => line.trim()) ?? text).trim().slice(0, 300);
}

/** Turn a worker reply into a result: "OK", "ERR <error>", or undefined when it could not check. */
function workerResult(out: string | undefined, parser: string): SyntaxResult | undefined {
	if (out === undefined) return undefined;
	return out.startsWith("OK") ? { ok: true, parser } : { ok: false, error: out.slice(4), parser };
}

const typeScriptChecker: Checker = async (content, path, cwd) => {
	const module = projectTypeScript(cwd);
	if (!module && ![".js", ".mjs", ".cjs"].includes(extname(path).toLowerCase())) return undefined;
	if (!(await has("node"))) return undefined;
	nodeWorker ??= new ParserWorker("node", ["--experimental-vm-modules", "--no-warnings", "-e", NODE_WORKER]);
	const out = await nodeWorker.parse({ text: content, file: path, module });
	return workerResult(out, module ? "typescript" : "node");
};

let python: Promise<string | undefined> | undefined;

/**
 * A Python interpreter that runs, or undefined. Being on PATH is not enough: on Windows,
 * `python.exe` and `python3.exe` in WindowsApps are Store placeholders that exit with an
 * error, and a real install provides `python` and `py` but not `python3`. Probed once.
 */
export function pythonInterpreter(): Promise<string | undefined> {
	python ??= (async () => {
		const candidates = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
		for (const candidate of candidates) {
			if ((await runParser(candidate, ["-c", "import ast"], "", process.cwd())).status === 0) return candidate;
		}
		return undefined;
	})();
	return python;
}

const pythonChecker: Checker = async (content, path) => {
	const interpreter = await pythonInterpreter();
	if (!interpreter) return undefined;
	pythonWorker ??= new ParserWorker(interpreter, ["-c", PYTHON_WORKER]);
	return workerResult(await pythonWorker.parse({ text: content, file: path }), "python ast");
};

const goChecker: Checker = async (content, _path, cwd) => {
	if (!(await has("gofmt"))) return undefined;
	const { status, out } = await runParser("gofmt", ["-e"], content, cwd);
	if (status === null) return undefined;
	if (status === 0) return { ok: true, parser: "gofmt" };
	return { ok: false, error: firstLine(out.replace(/^<standard input>:/gm, "")), parser: "gofmt" };
};

const rustChecker: Checker = async (content, _path, cwd) => {
	if (!(await has("rustfmt"))) return undefined;
	const { status, out } = await runParser("rustfmt", ["--edition", "2021", "--emit", "stdout"], content, cwd);
	if (status === null) return undefined;
	if (status === 0) return { ok: true, parser: "rustfmt" };
	const error = out.split(/\r?\n/).find((line) => line.startsWith("error")) ?? firstLine(out);
	const location = /<stdin>:(\d+:\d+)/.exec(out)?.[1];
	return { ok: false, error: `${location ? `${location} ` : ""}${error}`, parser: "rustfmt" };
};

const jsonChecker: Checker = async (content) => {
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
export async function checkSyntax(content: string, path: string, cwd: string): Promise<SyntaxResult | undefined> {
	const checker = CHECKERS[extname(path).toLowerCase()];
	if (!checker) return undefined;
	try {
		return await checker(content, path, cwd);
	} catch {
		return undefined;
	}
}

/**
 * Decide whether an edit from `before` to `after` introduced a syntax error. `before` is
 * undefined for a new file, which counts as valid. Returns the error to report, or undefined
 * when the edit is acceptable (parses, was already broken, or cannot be checked).
 */
export async function introducedSyntaxError(
	before: string | undefined,
	after: string,
	path: string,
	cwd: string,
): Promise<SyntaxResult | undefined> {
	const next = await checkSyntax(after, path, cwd);
	if (!next || next.ok) return undefined;
	if (before !== undefined) {
		const previous = await checkSyntax(before, path, cwd);
		if (!previous || !previous.ok) return undefined;
	}
	return next;
}
