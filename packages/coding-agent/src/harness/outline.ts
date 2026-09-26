import { extname } from "node:path";

/**
 * Line-based symbol outlines and relative imports for the common languages, with no parser
 * dependency. They feed the repo map, file ranking, `lookup` without a language server, and
 * related-test selection.
 *
 * Why not a real parser: these only need declaration names and lines, which top-level and
 * one-level-indented declarations carry in every mainstream style. A missed symbol costs a
 * little ranking quality; it never changes a file.
 */

export type SymbolKind = "function" | "class" | "method" | "type" | "variable" | "module";

export interface OutlineSymbol {
	name: string;
	kind: SymbolKind;
	/** 1-based. */
	line: number;
	/** The declaration line, trimmed and capped. */
	signature: string;
	/** Enclosing class or impl for methods. */
	parent?: string;
}

export type Language = "ts" | "py" | "go" | "rust" | "java" | "other";

const EXTENSIONS: Record<string, Language> = {
	".ts": "ts",
	".tsx": "ts",
	".mts": "ts",
	".cts": "ts",
	".js": "ts",
	".jsx": "ts",
	".mjs": "ts",
	".cjs": "ts",
	".py": "py",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".kt": "java",
	".cs": "java",
};

export function languageOf(path: string): Language {
	return EXTENSIONS[extname(path).toLowerCase()] ?? "other";
}

const CONTROL_WORDS = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"return",
	"function",
	"else",
	"do",
	"try",
	"new",
	"await",
	"typeof",
	"super",
	"constructor",
]);

interface Rule {
	pattern: RegExp;
	kind: SymbolKind;
	/** Only lines with this indentation (in columns) match; undefined matches top level only. */
	indented?: boolean;
	/** The symbol opens a scope whose indented methods belong to it. */
	container?: boolean;
}

const RULES: Record<Exclude<Language, "other">, Rule[]> = {
	ts: [
		{ pattern: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
		{
			pattern: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
			kind: "class",
			container: true,
		},
		{ pattern: /^(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, kind: "type" },
		{ pattern: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: "variable" },
		{ pattern: /^module\.exports\.([A-Za-z_$][\w$]*)\s*=/, kind: "variable" },
		{ pattern: /^exports\.([A-Za-z_$][\w$]*)\s*=/, kind: "variable" },
		{
			pattern:
				/^(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)?\s*(?::[^={]*)?(?:\{.*)?$/,
			kind: "method",
			indented: true,
		},
	],
	py: [
		{ pattern: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
		{ pattern: /^class\s+([A-Za-z_]\w*)/, kind: "class", container: true },
		{ pattern: /^([A-Z][A-Z0-9_]*)\s*(?::[^=]*)?=/, kind: "variable" },
		{ pattern: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "method", indented: true },
	],
	go: [
		{ pattern: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
		{ pattern: /^type\s+([A-Za-z_]\w*)/, kind: "type" },
		{ pattern: /^(?:var|const)\s+([A-Za-z_]\w*)/, kind: "variable" },
	],
	rust: [
		{
			pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/,
			kind: "function",
		},
		{ pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union|type)\s+([A-Za-z_]\w*)/, kind: "type" },
		{ pattern: /^impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_]\w*)/, kind: "class", container: true },
		{ pattern: /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, kind: "module" },
		{
			pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/,
			kind: "method",
			indented: true,
		},
	],
	java: [
		{
			pattern:
				/^(?:(?:public|private|protected|internal|abstract|final|sealed|static|data|open)\s+)*(?:class|interface|enum|record|object|struct)\s+([A-Za-z_]\w*)/,
			kind: "class",
			container: true,
		},
		{
			pattern:
				/^(?:(?:public|private|protected|internal|static|final|abstract|override|async|virtual|synchronized)\s+)+[\w<>[\],.? ]+\s+([A-Za-z_]\w*)\s*\(/,
			kind: "method",
			indented: true,
		},
		{
			pattern: /^(?:(?:private|public|internal|override|suspend)\s+)*fun\s+([A-Za-z_]\w*)/,
			kind: "method",
			indented: true,
		},
	],
};

function indentWidth(line: string): number {
	let width = 0;
	for (const char of line) {
		if (char === " ") width++;
		else if (char === "\t") width += 4;
		else break;
	}
	return width;
}

const MAX_SIGNATURE = 120;

/** Declarations at the top level and methods one level into a class, impl or object. */
export function outlineSource(path: string, text: string, maxSymbols = 200): OutlineSymbol[] {
	const language = languageOf(path);
	if (language === "other") return [];
	const rules = RULES[language];
	const symbols: OutlineSymbol[] = [];
	const lines = text.split(/\r?\n/);
	let container: { name: string; indent: number } | undefined;
	let methodIndent: number | undefined;
	for (let index = 0; index < lines.length && symbols.length < maxSymbols; index++) {
		const raw = lines[index];
		const trimmed = raw.trim();
		if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;
		const indent = indentWidth(raw);
		if (container && indent <= container.indent && !trimmed.startsWith("}") && !trimmed.startsWith(")")) {
			container = undefined;
			methodIndent = undefined;
		}
		for (const rule of rules) {
			if (rule.indented) {
				if (!container || indent <= container.indent) continue;
				if (methodIndent !== undefined && indent !== methodIndent) continue;
			} else if (indent !== 0) continue;
			const match = rule.pattern.exec(trimmed);
			if (!match) continue;
			const name = match[1];
			if (language === "ts" && CONTROL_WORDS.has(name)) continue;
			if (rule.indented) methodIndent = indent;
			symbols.push({
				name,
				kind: rule.kind,
				line: index + 1,
				signature: trimmed.length > MAX_SIGNATURE ? `${trimmed.slice(0, MAX_SIGNATURE - 3)}...` : trimmed,
				parent: rule.indented ? container?.name : undefined,
			});
			if (rule.container) {
				container = { name, indent };
				methodIndent = undefined;
			}
			break;
		}
	}
	return symbols;
}

function indentOfLine(line: string): number {
	return /^[ \t]*/.exec(line)?.[0].replace(/\t/g, "    ").length ?? 0;
}

/**
 * The declaration starting at `startLine` (1-based): through the matching closing brace for
 * brace languages, or while lines stay indented deeper for Python-style blocks.
 */
export function declarationBody(lines: readonly string[], startLine: number, maxLines = 40): string {
	const start = startLine - 1;
	const first = lines[start] ?? "";
	const baseIndent = indentOfLine(first);
	const out: string[] = [];
	let depth = 0;
	let sawBrace = false;
	for (let index = start; index < lines.length && out.length < maxLines; index++) {
		const line = lines[index];
		out.push(`${index + 1}\t${line}`);
		for (const char of line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "")) {
			if (char === "{") {
				depth++;
				sawBrace = true;
			} else if (char === "}") depth--;
		}
		if (sawBrace && depth <= 0) break;
		if (!sawBrace && index > start) {
			const next = lines[index + 1];
			if (
				next !== undefined &&
				next.trim() !== "" &&
				indentOfLine(next) <= baseIndent &&
				!/^[)\]}]/.test(next.trim())
			) {
				break;
			}
		}
		if (!sawBrace && index === start && /;\s*$/.test(line)) break;
	}
	while (out.length > 1 && /^\d+\t\s*$/.test(out[out.length - 1])) out.pop();
	const truncated =
		out.length >= maxLines
			? `\n[... body continues; read ${lines.length > startLine ? `from line ${startLine + maxLines}` : "the file"} for the rest ...]`
			: "";
	return out.join("\n") + truncated;
}

/** Relative module specifiers a file imports (`./x`, `../y`, Python relative and sibling modules). */
export function relativeImports(path: string, text: string): string[] {
	const language = languageOf(path);
	const found = new Set<string>();
	if (language === "ts") {
		for (const match of text.matchAll(/(?:from\s+|require\(\s*|import\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
			found.add(match[1]);
		}
	} else if (language === "py") {
		for (const match of text.matchAll(/^\s*from\s+(\.+[\w.]*|[\w.]+)\s+import\s+([\w, ]+)/gm)) {
			found.add(match[1]);
			if (/^\.+$/.test(match[1])) for (const name of match[2].split(",")) found.add(`${match[1]}${name.trim()}`);
		}
		for (const match of text.matchAll(/^\s*import\s+([\w.]+)/gm)) found.add(match[1]);
	}
	return [...found];
}

/** Split identifiers and words into lowercase search terms: `parsePortNumber` -> parse, port, number. */
export function identifierTerms(text: string): string[] {
	const terms: string[] = [];
	for (const word of text.match(/[A-Za-z][A-Za-z0-9]*|[0-9]+/g) ?? []) {
		const parts = word
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
			.split(" ");
		for (const part of parts) {
			let term = part.toLowerCase();
			// Plural and singular are the same subject: "results" finds "result".
			if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) term = term.slice(0, -1);
			if (term.length >= 2 && !STOP_WORDS.has(term)) terms.push(term);
		}
	}
	return terms;
}

const STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"that",
	"this",
	"with",
	"from",
	"are",
	"was",
	"but",
	"not",
	"you",
	"all",
	"can",
	"has",
	"have",
	"its",
	"our",
	"out",
	"use",
	"when",
	"what",
	"which",
	"will",
	"would",
	"should",
	"could",
	"into",
	"then",
	"than",
	"them",
	"they",
	"there",
	"their",
	"it",
	"is",
	"in",
	"of",
	"to",
	"on",
	"or",
	"an",
	"as",
	"at",
	"be",
	"by",
	"do",
	"if",
	"so",
	"we",
	"my",
	"me",
	"no",
	"make",
	"fix",
	"please",
	"return",
	"const",
	"let",
	"var",
	"import",
	"export",
	"new",
	"true",
	"false",
	"null",
	"undefined",
	"self",
	"def",
	"function",
]);
