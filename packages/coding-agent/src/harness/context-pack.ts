import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DetectedCheck, ProjectFacts } from "./detect-checks.ts";
import { declarationBody, identifierTerms, type OutlineSymbol } from "./outline.ts";
import { type RankedFile, rankFiles, type WorkspaceIndex } from "./workspace-index.ts";

/**
 * The context pack: what a model would otherwise learn in its first turns of `ls`, `find`,
 * `grep` and `read`, computed in code before the first request.
 *
 * Example: "parsePort in port.js should only return valid ports". Without a pack, a fast
 * model typically lists the directory, greps for parsePort, reads port.js, then reads the
 * test: four turns, each resending the whole prompt. With the pack, the first request
 * already holds port.js, its test, the test command and the shell, so the first turn can
 * edit.
 *
 * Everything in it is deterministic and bounded by a token budget.
 */

/** Rough bytes per token for code and English, used only to relate bytes to a token budget. */
const BYTES_PER_TOKEN = 4;

export interface EnvironmentInput {
	facts: ProjectFacts;
	/** Checks the harness runs when the model finishes, if any. */
	checks: ReadonlyArray<Pick<DetectedCheck, "name" | "command">>;
	platform: NodeJS.Platform;
	shell: "powershell" | "bash" | undefined;
}

export interface PackInput {
	index: WorkspaceIndex;
	request: string;
	git?: { branch?: string; changed: string[] };
	budgetTokens: number;
}

export interface ContextPack {
	text: string;
	/** Paths whose full content is included. */
	inlined: string[];
	ranked: string[];
	bytes: number;
}

const KIND_ORDER: Record<string, number> = { function: 0, class: 0, type: 1, module: 1, variable: 2, method: 3 };

/** Declarations to name for a file: functions and classes first, in file order. */
function symbolSummary(symbols: readonly OutlineSymbol[], max = 8): string {
	const top = symbols
		.filter((symbol) => symbol.kind !== "method")
		.map((symbol, order) => ({ symbol, order }))
		.sort((a, b) => (KIND_ORDER[a.symbol.kind] ?? 9) - (KIND_ORDER[b.symbol.kind] ?? 9) || a.order - b.order)
		.slice(0, max)
		.map((item) => item.symbol);
	const names = top.map((symbol) => `${symbol.name}:${symbol.line}`);
	const more = symbols.length - top.length;
	return names.length === 0 ? "" : ` — ${names.join(", ")}${more > 0 ? ` (+${more})` : ""}`;
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

function describeGit(git: NonNullable<PackInput["git"]>): string {
	const changed = git.changed.slice(0, 10);
	return `Git: ${git.branch ? `branch ${git.branch}, ` : ""}${git.changed.length === 0 ? "clean working tree" : `${git.changed.length} changed file(s): ${changed.join(", ")}${git.changed.length > changed.length ? ", ..." : ""}`}.`;
}

/** Build the pack. Returns undefined for an empty workspace. */
export function buildContextPack(input: PackInput): ContextPack | undefined {
	const budget = input.budgetTokens * BYTES_PER_TOKEN;
	const ranked = rankFiles(input.index, input.request, 10);
	if (input.index.files.length === 0) return undefined;
	const sections: string[] = [];
	const environment = input.git ? describeGit(input.git) : "";
	let used = Buffer.byteLength(environment);

	const rankedLines: string[] = [];
	for (const item of ranked) {
		const line = `- ${item.file.path}${symbolSummary(item.file.symbols)}${item.reasons.length > 0 ? ` [${item.reasons.join("; ")}]` : ""}`;
		if (used + Buffer.byteLength(line) > budget * 0.3) break;
		rankedLines.push(line);
		used += Buffer.byteLength(line) + 1;
	}

	// Inline the strongest candidates whole while they fit in about half the budget: a fast
	// model edits from what it can see, and a whole small file costs less than a read turn.
	// A candidate too large to inline contributes the declarations the request is about.
	const inlined: string[] = [];
	const fileBlocks: string[] = [];
	const inlineBudget = budget * 0.55;
	const queryTerms = new Set(identifierTerms(input.request));
	const requestWords = new Set(input.request.match(/[A-Za-z_$][\w$]*/g) ?? []);
	let inlineUsed = 0;
	for (const item of pickInline(ranked)) {
		let text: string;
		try {
			text = readFileSync(join(input.index.root, item.file.path), "utf8");
		} catch {
			continue;
		}
		const block = `<file path="${item.file.path}">\n${text.replace(/\s+$/, "")}\n</file>`;
		const size = Buffer.byteLength(block);
		if (inlineUsed + size <= inlineBudget) {
			inlineUsed += size;
			inlined.push(item.file.path);
			fileBlocks.push(block);
			continue;
		}
		const excerpt = excerptFor(
			item.file.path,
			text,
			item.file.symbols,
			queryTerms,
			requestWords,
			inlineBudget - inlineUsed,
		);
		if (excerpt) {
			inlineUsed += Buffer.byteLength(excerpt);
			fileBlocks.push(excerpt);
		}
	}
	used += inlineUsed;

	// Fill what is left with a map of other files and their symbols.
	const mapLines: string[] = [];
	const listed = new Set(ranked.map((item) => item.file.path));
	// Map order: files beside the ranked ones first, then source before tests, docs and
	// dot-directories (CI config and templates are rarely what a request is about).
	const rankedDirs = new Set(ranked.map((item) => dirname(item.file.path)));
	const tier = (path: string, isTest: boolean) =>
		(rankedDirs.has(dirname(path)) ? 0 : 4) +
		(/(^|\/)\./.test(path) ? 3 : /\.(md|txt|ya?ml|json|toml)$/.test(path) ? 2 : isTest ? 1 : 0);
	const others = input.index.files
		.filter((file) => !listed.has(file.path))
		.sort((a, b) => tier(a.path, a.isTest) - tier(b.path, b.isTest) || a.path.localeCompare(b.path));
	for (const file of others) {
		const line = `${file.path}${symbolSummary(file.symbols, 5)}`;
		const size = Buffer.byteLength(line) + 1;
		if (used + size > budget) break;
		mapLines.push(line);
		used += size;
	}
	const omitted = others.length - mapLines.length;

	if (environment) sections.push(environment);
	if (rankedLines.length > 0) {
		sections.push(`Files most related to this request (path — symbol:line):\n${rankedLines.join("\n")}`);
	}
	if (fileBlocks.length > 0) sections.push(`Current contents:\n${fileBlocks.join("\n")}`);
	if (mapLines.length > 0 || omitted > 0) {
		sections.push(
			`Other files:\n${mapLines.join("\n")}${omitted > 0 ? `\n(${omitted} more file(s) not listed${input.index.truncated ? "; the index stopped at 20,000 files" : ""})` : ""}`,
		);
	}
	const text = [
		"<workspace_context>",
		"The harness gathered this before your first step. It reflects the files as they are now; read a file again after it changes.",
		...sections,
		"</workspace_context>",
	].join("\n\n");
	return { text, inlined, ranked: ranked.map((item) => item.file.path), bytes: Buffer.byteLength(text) };
}

/**
 * The declarations of a large file that match the request, with line numbers, as an excerpt
 * block. Undefined when none match or none fit.
 */
function excerptFor(
	path: string,
	text: string,
	symbols: readonly OutlineSymbol[],
	queryTerms: ReadonlySet<string>,
	requestWords: ReadonlySet<string>,
	room: number,
): string | undefined {
	const lines = text.split(/\r?\n/);
	const scored = symbols
		.map((symbol) => {
			const terms = identifierTerms(symbol.name);
			const hits = terms.filter((term) => queryTerms.has(term)).length;
			// A symbol the request names outright beats one that shares words with it.
			const named = requestWords.has(symbol.name) ? 10 : 0;
			const callable = symbol.kind === "function" || symbol.kind === "method" || symbol.kind === "class" ? 1 : 0;
			return { symbol, hits: hits > 0 ? named + hits + callable + hits / Math.max(1, terms.length) : 0 };
		})
		.filter((item) => item.hits > 0)
		.sort((a, b) => b.hits - a.hits || a.symbol.line - b.symbol.line);
	const bodies: string[] = [];
	let size = 0;
	for (const { symbol } of scored.slice(0, 3)) {
		const body = declarationBody(lines, symbol.line, 30);
		const bytes = Buffer.byteLength(body) + 1;
		if (size + bytes + 200 > room) continue;
		bodies.push(body);
		size += bytes;
	}
	if (bodies.length === 0) return undefined;
	return `<excerpt path="${path}" lines="${lines.length}" note="line-numbered; read the file for the rest">\n${bodies.join("\n...\n")}\n</excerpt>`;
}

/** The top result, plus its partner (test or source) when the pair is clearly the target. */
function pickInline(ranked: readonly RankedFile[]): RankedFile[] {
	if (ranked.length === 0) return [];
	const [first, ...rest] = ranked;
	const picks = [first];
	for (const item of rest.slice(0, 4)) {
		if (item.score >= first.score * 0.35) picks.push(item);
	}
	return picks.slice(0, 4);
}

/**
 * The short form for later prompts in the same session: the model already has the
 * environment and earlier files in context, so only the ranking is new.
 */
export function buildFollowUpPack(index: WorkspaceIndex, request: string): string | undefined {
	const ranked = rankFiles(index, request, 6).filter((item) => item.score > 1);
	if (ranked.length === 0) return undefined;
	return [
		"<workspace_context>",
		"Files most related to this request (path — symbol:line):",
		...ranked.map((item) => `- ${item.file.path}${symbolSummary(item.file.symbols)}`),
		"</workspace_context>",
	].join("\n");
}
