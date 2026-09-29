import { extname } from "node:path";

/**
 * Line-based symbol outlines and relative imports for the common languages, with no parser
 * dependency. They feed the drift guard's removed-declaration check and related-test selection.
 *
 * Why not a real parser: these only need declaration names and lines, which top-level and
 * one-level-indented declarations carry in every mainstream style. A missed symbol costs a
 * missed signal; it never changes a file.
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
		// Not `const x = require(...)`: an import, not a declaration worth listing.
		{
			pattern: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=](?!\s*(?:require|await\s+import)\s*\()/,
			kind: "variable",
		},
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
