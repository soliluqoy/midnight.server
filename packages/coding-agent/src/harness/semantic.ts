import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type LspDiagnostic, type LspManager, type LspSymbol, uriPath } from "./lsp.ts";
import { declarationBody, identifierTerms, outlineSource } from "./outline.ts";

export { declarationBody };

import type { WorkspaceIndex } from "./workspace-index.ts";

/**
 * The `lookup` tool's operations and diagnostics after an edit.
 *
 * Every operation works without a language server (from the harness's own outlines and a
 * word search), and uses one when the project has it, for exact answers. The model never
 * has to supply line and column positions: it names a symbol, and the harness finds it.
 */

export type LookupOp = "definition" | "references" | "outline";

export interface LookupInput {
	op: LookupOp;
	symbol?: string;
	path?: string;
}

const MAX_DEFINITIONS = 3;
const MAX_REFERENCES = 60;

function rel(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

function readLines(root: string, path: string): string[] | undefined {
	try {
		return readFileSync(join(root, path), "utf8").split(/\r?\n/);
	} catch {
		return undefined;
	}
}

function wordPattern(symbol: string): RegExp {
	return new RegExp(`(^|[^\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
}

function flattenSymbols(symbols: readonly LspSymbol[], depth = 0, out: string[] = []): string[] {
	for (const symbol of symbols) {
		const range = symbol.selectionRange ?? symbol.range ?? symbol.location?.range;
		const line = range ? range.start.line + 1 : undefined;
		out.push(
			`${"  ".repeat(depth)}${SYMBOL_KINDS[symbol.kind] ?? "symbol"} ${symbol.name}${line ? ` :${line}` : ""}`,
		);
		if (symbol.children && depth < 2) flattenSymbols(symbol.children, depth + 1, out);
	}
	return out;
}

const SYMBOL_KINDS: Record<number, string> = {
	2: "module",
	3: "namespace",
	5: "class",
	6: "method",
	7: "property",
	8: "field",
	9: "constructor",
	10: "enum",
	11: "interface",
	12: "function",
	13: "variable",
	14: "constant",
	22: "enum member",
	23: "struct",
	26: "type parameter",
};

export async function runLookup(
	input: LookupInput,
	index: WorkspaceIndex,
	lsp: LspManager | undefined,
	signal?: AbortSignal,
): Promise<string> {
	const root = index.root;
	if (input.op === "outline") {
		if (!input.path) throw new Error("outline needs path");
		const path = input.path.replace(/\\/g, "/").replace(/^\.\//, "");
		const absolute = join(root, path);
		const client = lsp ? await lsp.clientFor(absolute) : undefined;
		if (client && !signal?.aborted) {
			try {
				client.sync(absolute);
				const symbols = await client.documentSymbols(absolute);
				if (symbols.length > 0)
					return `Outline of ${path} (from ${client.spec.id} language server):\n${flattenSymbols(symbols).join("\n")}`;
			} catch {
				// Fall back to the harness outline.
			}
		}
		const lines = readLines(root, path);
		if (!lines) throw new Error(`File not found: ${path}`);
		const symbols = outlineSource(path, lines.join("\n"), 400);
		if (symbols.length === 0) return `No declarations found in ${path}. Read it instead.`;
		return `Outline of ${path}:\n${symbols.map((symbol) => `${symbol.parent ? "  " : ""}${symbol.kind} ${symbol.name} :${symbol.line}`).join("\n")}`;
	}

	const symbol = input.symbol?.trim();
	if (!symbol) throw new Error(`${input.op} needs symbol`);
	const bare = symbol.split(/[.#:]/).pop() ?? symbol;
	const hint = input.path?.replace(/\\/g, "/").replace(/^\.\//, "");

	// Declarations from the harness index, the path hint first.
	const declarations = index.files
		.flatMap((file) =>
			file.symbols.filter((item) => item.name === bare).map((item) => ({ path: file.path, symbol: item })),
		)
		.sort(
			(a, b) =>
				Number(b.path === hint) - Number(a.path === hint) ||
				Number(a.path.includes("test")) - Number(b.path.includes("test")),
		);

	if (input.op === "definition") {
		const found = declarations.slice(0, MAX_DEFINITIONS);
		if (found.length === 0 && lsp && hint) {
			// The index misses some forms (object members, re-exports); ask the server.
			const client = await lsp.clientFor(join(root, hint));
			if (client) {
				try {
					client.sync(join(root, hint));
					const symbols = await client.workspaceSymbols(bare);
					for (const item of symbols.filter((candidate) => candidate.name === bare).slice(0, MAX_DEFINITIONS)) {
						if (!item.location) continue;
						const path = rel(root, uriPath(item.location.uri));
						const lines = readLines(root, path);
						if (lines) {
							found.push({
								path,
								symbol: {
									name: bare,
									kind: "function",
									line: item.location.range.start.line + 1,
									signature: lines[item.location.range.start.line]?.trim() ?? "",
								},
							});
						}
					}
				} catch {
					// Fall through to "not found".
				}
			}
		}
		if (found.length === 0) {
			const uses = grepWord(index, bare, 5);
			return uses.length > 0
				? `No declaration of ${bare} found. It appears in:\n${uses.join("\n")}`
				: `No declaration or use of ${bare} found in the workspace.`;
		}
		const blocks = found.map(({ path, symbol: item }) => {
			const lines = readLines(root, path) ?? [];
			return `${path}:${item.line}${item.parent ? ` (in ${item.parent})` : ""}\n${declarationBody(lines, item.line)}`;
		});
		const more = declarations.length - found.length;
		return `${blocks.join("\n\n")}${more > 0 ? `\n\n(${more} more declaration(s) named ${bare})` : ""}`;
	}

	// references
	const target = declarations[0];
	if (target && lsp) {
		const absolute = join(root, target.path);
		const client = await lsp.clientFor(absolute);
		const lines = readLines(root, target.path);
		if (client && lines) {
			const line = lines[target.symbol.line - 1] ?? "";
			const character = Math.max(
				0,
				line.search(wordPattern(bare)) + (wordPattern(bare).exec(line)?.[1].length ?? 0),
			);
			try {
				client.sync(absolute);
				const locations = await client.references(absolute, { line: target.symbol.line - 1, character });
				if (locations.length > 0) {
					const shown = locations.slice(0, MAX_REFERENCES).map((location) => {
						const path = rel(root, uriPath(location.uri));
						const text = readLines(root, path)?.[location.range.start.line]?.trim() ?? "";
						return `${path}:${location.range.start.line + 1}: ${text.slice(0, 160)}`;
					});
					return `References to ${bare} (defined at ${target.path}:${target.symbol.line}, from ${client.spec.id} language server):\n${shown.join("\n")}${locations.length > shown.length ? `\n(${locations.length - shown.length} more)` : ""}`;
				}
			} catch {
				// Fall back to a word search.
			}
		}
	}
	const uses = grepWord(index, bare, MAX_REFERENCES);
	if (uses.length === 0) return `No uses of ${bare} found in the workspace.`;
	return `Uses of ${bare} (word search${target ? `; defined at ${target.path}:${target.symbol.line}` : ""}):\n${uses.join("\n")}`;
}

function grepWord(index: WorkspaceIndex, word: string, max: number): string[] {
	const pattern = wordPattern(word);
	const terms = identifierTerms(word);
	const hits: string[] = [];
	for (const file of index.files) {
		// Cheap prefilter: every term of the word must occur in the file's indexed terms.
		if (!terms.every((term) => file.terms.has(term))) continue;
		const lines = readLines(index.root, file.path);
		if (!lines) continue;
		for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
			if (pattern.test(lines[lineIndex])) {
				hits.push(`${file.path}:${lineIndex + 1}: ${lines[lineIndex].trim().slice(0, 160)}`);
				if (hits.length >= max) return hits;
			}
		}
	}
	return hits;
}

function diagnosticKey(item: LspDiagnostic): string {
	return `${item.code ?? ""}\0${item.message}`;
}

/**
 * Errors a language server reports for `path` after an edit that it did not report before.
 * `before` are the file's errors from before the edit, when known.
 */
export function newErrors(
	before: readonly LspDiagnostic[] | undefined,
	after: readonly LspDiagnostic[],
): LspDiagnostic[] {
	const errors = after.filter((item) => (item.severity ?? 1) === 1);
	if (!before) return errors;
	const seen = new Map<string, number>();
	for (const item of before) {
		if ((item.severity ?? 1) !== 1) continue;
		seen.set(diagnosticKey(item), (seen.get(diagnosticKey(item)) ?? 0) + 1);
	}
	return errors.filter((item) => {
		const count = seen.get(diagnosticKey(item)) ?? 0;
		if (count > 0) {
			seen.set(diagnosticKey(item), count - 1);
			return false;
		}
		return true;
	});
}

export function formatDiagnostics(path: string, items: readonly LspDiagnostic[], source: string, max = 5): string {
	const shown = items.slice(0, max).map((item) => {
		const message = item.message.replace(/\s+/g, " ").slice(0, 240);
		return `${path}:${item.range.start.line + 1}:${item.range.start.character + 1}: ${message}`;
	});
	return [
		`[harness: ${source} reports ${items.length} new error(s) after this edit:]`,
		...shown,
		...(items.length > shown.length ? [`(${items.length - shown.length} more)`] : []),
	].join("\n");
}
