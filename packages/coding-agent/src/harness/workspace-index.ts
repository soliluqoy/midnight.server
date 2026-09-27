import { execFile } from "node:child_process";
import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, parse, posix, relative, resolve, sep } from "node:path";
import {
	forEachIdentifierTerm,
	identifierTerms,
	languageOf,
	type OutlineSymbol,
	outlineSource,
	relativeImports,
} from "./outline.ts";

/**
 * A lexical index of the workspace: files, their symbols, imports and term statistics, and
 * BM25 ranking against a request. It is what the harness uses instead of letting the model
 * spend its first turns on `ls`, `find` and `grep`.
 *
 * Why lexical and not embeddings: requests about code name its identifiers ("parsePort",
 * "the CSV parser"), and identifier-aware BM25 over paths, symbols and content finds those
 * in milliseconds with no model. Embeddings help when the request and the code share no
 * words; that case is left to the model's own search tools.
 */

export interface IndexedFile {
	path: string;
	bytes: number;
	mtimeMs: number;
	symbols: OutlineSymbol[];
	imports: string[];
	/** Term frequencies over path (weighted), symbol names (weighted) and content. */
	terms: Map<string, number>;
	/** Terms of the path and declared symbol names: what the file is about, not what it mentions. */
	nameTerms: Set<string>;
	/** Terms of the file name alone. */
	baseTerms: Set<string>;
	length: number;
	isTest: boolean;
}

export interface WorkspaceIndex {
	root: string;
	files: IndexedFile[];
	byPath: Map<string, IndexedFile>;
	documentFrequency: Map<string, number>;
	averageLength: number;
	/** True when the file list was cut at `MAX_FILES`. */
	truncated: boolean;
}

const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 512_000;
const MAX_INDEXED_CONTENT = 64_000;
const PATH_WEIGHT = 4;
const SYMBOL_WEIGHT = 3;

const IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	"coverage",
	".next",
	".nuxt",
	".venv",
	"venv",
	"__pycache__",
	".mypy_cache",
	".pytest_cache",
	".tox",
	"vendor",
	".idea",
	".vscode",
	".midnight.server",
	".pi",
]);

const TEXT_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
	".kt",
	".cs",
	".c",
	".h",
	".cpp",
	".hpp",
	".rb",
	".php",
	".swift",
	".json",
	".md",
	".toml",
	".yaml",
	".yml",
	".sh",
	".ps1",
	".sql",
	".html",
	".css",
	".scss",
	".vue",
	".svelte",
]);

/** Under a dependency, build, cache or tool directory (node_modules, dist, __pycache__, ...). */
export function isGeneratedPath(path: string): boolean {
	return path.split("/").some((part) => IGNORED_DIRS.has(part));
}

export function isTestPath(path: string): boolean {
	return (
		/(^|\/)(test|tests|__tests__|spec|specs)\//.test(path) ||
		/\.(test|spec)\.[a-z]+$/.test(path) ||
		/(^|\/)test_[^/]+\.py$/.test(path) ||
		/_test\.(py|go)$/.test(path) ||
		/(^|\/)test\.[a-z]+$/.test(path)
	);
}

/**
 * A directory that is not a project: the home directory or a filesystem root. Indexing one walks
 * thousands of unrelated files (AppData, caches, downloads) before the first request.
 */
export function isUnindexableRoot(root: string): boolean {
	const normalize = (path: string) => {
		const resolved = resolve(path);
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	};
	const target = normalize(root);
	return target === normalize(homedir()) || target === normalize(parse(target).root);
}

function gitListFiles(root: string): Promise<string | undefined> {
	return new Promise((done) => {
		execFile(
			"git",
			["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			{ cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 30_000 },
			(error, stdout) => done(error || !stdout ? undefined : stdout),
		);
	});
}

/** Workspace files, preferring git's view (tracked plus untracked, respecting .gitignore). */
export async function listWorkspaceFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
	if (isUnindexableRoot(root)) return { files: [], truncated: false };
	const listed = await gitListFiles(root);
	let files: string[];
	let truncated = false;
	if (listed) {
		files = listed
			.split("\0")
			.filter(Boolean)
			.filter((path) => !path.split("/").some((part) => IGNORED_DIRS.has(part)));
	} else {
		files = [];
		const walk = async (dir: string): Promise<void> => {
			let entries: Dirent[];
			try {
				entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (files.length >= MAX_FILES) {
					truncated = true;
					return;
				}
				if (entry.isDirectory()) {
					if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(join(dir, entry.name));
				} else if (entry.isFile()) {
					files.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
				}
			}
		};
		await walk(root);
	}
	const unique = [...new Set(files)].sort();
	return { files: unique.slice(0, MAX_FILES), truncated: truncated || unique.length > MAX_FILES };
}

function addTerm(target: Map<string, number>, term: string, weight: number): void {
	target.set(term, (target.get(term) ?? 0) + weight);
}

async function indexFile(root: string, path: string, previous: IndexedFile | undefined): Promise<IndexedFile | undefined> {
	if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase())) return undefined;
	let stats: Stats;
	try {
		stats = await stat(join(root, path));
	} catch {
		return undefined;
	}
	if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return undefined;
	if (previous && previous.mtimeMs === stats.mtimeMs && previous.bytes === stats.size) return previous;
	let text: string;
	try {
		const raw = await readFile(join(root, path));
		if (raw.subarray(0, 4000).includes(0)) return undefined;
		text = raw.toString("utf8");
	} catch {
		return undefined;
	}
	const symbols = outlineSource(path, text);
	const terms = new Map<string, number>();
	const pathTerms = identifierTerms(path);
	const symbolTerms = symbols.flatMap((symbol) => identifierTerms(symbol.name));
	for (const term of pathTerms) addTerm(terms, term, PATH_WEIGHT);
	for (const term of symbolTerms) addTerm(terms, term, SYMBOL_WEIGHT);
	let length = pathTerms.length * PATH_WEIGHT + symbolTerms.length * SYMBOL_WEIGHT;
	forEachIdentifierTerm(text.slice(0, MAX_INDEXED_CONTENT), (term) => {
		addTerm(terms, term, 1);
		length++;
	});
	return {
		path,
		bytes: stats.size,
		mtimeMs: stats.mtimeMs,
		symbols,
		imports: relativeImports(path, text),
		terms,
		nameTerms: new Set([...pathTerms, ...symbolTerms]),
		baseTerms: new Set(identifierTerms(basename(path))),
		length,
		isTest: isTestPath(path),
	};
}

/** Files stat'd and read concurrently while indexing; each batch also yields to the event loop. */
const INDEX_BATCH = 32;

/**
 * Build (or refresh, reusing unchanged files from `previous`) the index for `root`. File I/O is
 * asynchronous and batched, so the UI keeps rendering while a large workspace is indexed.
 */
export async function buildWorkspaceIndex(root: string, previous?: WorkspaceIndex): Promise<WorkspaceIndex> {
	const { files, truncated } = await listWorkspaceFiles(root);
	const indexed: IndexedFile[] = [];
	for (let start = 0; start < files.length; start += INDEX_BATCH) {
		const batch = await Promise.all(
			files.slice(start, start + INDEX_BATCH).map((path) => indexFile(root, path, previous?.byPath.get(path))),
		);
		for (const file of batch) if (file) indexed.push(file);
	}
	const documentFrequency = new Map<string, number>();
	let totalLength = 0;
	for (const file of indexed) {
		totalLength += file.length;
		for (const term of file.terms.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
	}
	return {
		root,
		files: indexed,
		byPath: new Map(indexed.map((file) => [file.path, file])),
		documentFrequency,
		averageLength: indexed.length > 0 ? totalLength / indexed.length : 1,
		truncated,
	};
}

export interface RankedFile {
	file: IndexedFile;
	score: number;
	/** Why it ranked: explicit mention, matched symbols, related to a ranked file. */
	reasons: string[];
}

const K1 = 1.2;
const B = 0.75;

/**
 * Rank files for a request. BM25 over identifier terms, plus strong boosts for files and
 * symbols the request names outright, and a pull toward each top file's tests and imports.
 */
export function rankFiles(index: WorkspaceIndex, request: string, limit = 12): RankedFile[] {
	const queryTerms = [...new Set(identifierTerms(request))];
	const count = index.files.length;
	const mentions = new Set(
		(request.match(/[\w./-]+\.[A-Za-z]{1,5}\b/g) ?? []).map((item) => item.replace(/\\/g, "/").replace(/^\.\//, "")),
	);
	// Only code-shaped words name symbols: `parsePort`, `parse_port`, `Parser`, or anything in
	// backticks. Plain English ("context", "compaction") matching a local variable is noise.
	const words = new Set(
		[
			...(request.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((word) => /[a-z][A-Z]|_|\d|^[A-Z][a-z]+[A-Z]/.test(word)),
			...[...request.matchAll(/`([A-Za-z_$][\w$.]*)`/g)].map((match) => match[1].split(".").pop() ?? match[1]),
			...(request.match(/\b[A-Z][a-z]+\b/g) ?? []).filter((word) => word.length >= 4),
		].filter(Boolean),
	);
	const wantsTests = /\b(tests?|specs?|testing)\b/i.test(request);
	const idf = new Map(
		queryTerms.map((term) => {
			const df = index.documentFrequency.get(term) ?? 0;
			return [term, Math.log(1 + (count - df + 0.5) / (df + 0.5))];
		}),
	);
	const scored: RankedFile[] = [];
	for (const file of index.files) {
		let score = 0;
		const reasons: string[] = [];
		for (const term of queryTerms) {
			const frequency = file.terms.get(term);
			if (!frequency) continue;
			const weight = idf.get(term) ?? 0;
			score +=
				(weight * frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * file.length) / index.averageLength));
			// A file named for, or declaring, what the request is about beats one that only mentions it.
			if (file.nameTerms.has(term)) score += weight * 1.5;
			if (file.baseTerms.has(term)) score += weight;
		}
		for (const mention of mentions) {
			if (file.path === mention || file.path.endsWith(`/${mention}`) || basename(file.path) === mention) {
				score += 50;
				reasons.push("named in the request");
				break;
			}
		}
		const namedSymbols = file.symbols.filter((symbol) => symbol.name.length >= 3 && words.has(symbol.name));
		if (namedSymbols.length > 0) {
			score += 20 * Math.min(3, namedSymbols.length);
			reasons.push(`defines ${[...new Set(namedSymbols.map((symbol) => symbol.name))].slice(0, 3).join(", ")}`);
		}
		if (file.isTest && !wantsTests && reasons.length === 0) score *= 0.6;
		if (score > 0) scored.push({ file, score, reasons });
	}
	scored.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
	const top = scored.slice(0, limit);
	// Pull in the tests of top source files and the sources of top tests: a fix needs both.
	const included = new Set(top.map((item) => item.file.path));
	const related: RankedFile[] = [];
	for (const item of top.slice(0, 4)) {
		for (const partner of relatedFiles(index, item.file)) {
			if (included.has(partner.path)) continue;
			included.add(partner.path);
			related.push({
				file: partner,
				score: item.score * 0.5,
				reasons: [`${partner.isTest ? "tests" : "imported by"} ${item.file.path}`],
			});
		}
	}
	return [...top, ...related].sort((a, b) => b.score - a.score).slice(0, limit);
}

function stem(path: string): string {
	return basename(path)
		.replace(/\.[^.]+$/, "")
		.replace(/\.(test|spec)$/, "")
		.replace(/^test_/, "")
		.replace(/_test$/, "");
}

/** Resolve a relative import specifier from `from` to an indexed file. */
export function resolveImport(index: WorkspaceIndex, from: string, specifier: string): IndexedFile | undefined {
	if (languageOf(from) === "py") {
		const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
		let base = dirname(from);
		for (let level = 1; level < dots; level++) base = dirname(base);
		const rest = specifier.slice(dots).split(".").filter(Boolean).join("/");
		const candidates = dots > 0 ? [posix.join(base, rest)] : [rest, posix.join(dirname(from), rest)];
		for (const candidate of candidates) {
			const hit = index.byPath.get(`${candidate}.py`) ?? index.byPath.get(`${candidate}/__init__.py`);
			if (hit) return hit;
		}
		return undefined;
	}
	const target = posix.normalize(posix.join(dirname(from), specifier));
	const stripped = target.replace(/\.(js|mjs|cjs|jsx)$/, "");
	for (const candidate of [
		target,
		...[".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs"].map((ext) => `${stripped}${ext}`),
		...["index.ts", "index.tsx", "index.js"].map((name) => `${target}/${name}`),
	]) {
		const hit = index.byPath.get(candidate);
		if (hit) return hit;
	}
	return undefined;
}

/**
 * Files that belong with `file`: its tests (same stem, or tests that import it) when it is
 * source, and the sources it imports when it is a test.
 */
export function relatedFiles(index: WorkspaceIndex, file: IndexedFile): IndexedFile[] {
	const result = new Map<string, IndexedFile>();
	const fileStem = stem(file.path);
	if (file.isTest) {
		for (const specifier of file.imports) {
			const hit = resolveImport(index, file.path, specifier);
			if (hit && !hit.isTest) result.set(hit.path, hit);
		}
		for (const other of index.files) {
			if (!other.isTest && stem(other.path) === fileStem && languageOf(other.path) === languageOf(file.path)) {
				result.set(other.path, other);
			}
		}
	} else {
		for (const other of index.files) {
			if (!other.isTest || languageOf(other.path) !== languageOf(file.path)) continue;
			if (stem(other.path) === fileStem) {
				result.set(other.path, other);
				continue;
			}
			if (other.imports.some((specifier) => resolveImport(index, other.path, specifier)?.path === file.path)) {
				result.set(other.path, other);
			}
		}
	}
	result.delete(file.path);
	return [...result.values()].slice(0, 6);
}

/** Every indexed test file related to any of `paths`. Used to pick which tests to run. */
export function testsFor(index: WorkspaceIndex, paths: readonly string[]): string[] {
	const tests = new Set<string>();
	for (const path of paths) {
		const file = index.byPath.get(path);
		if (!file) continue;
		if (file.isTest) tests.add(file.path);
		else for (const related of relatedFiles(index, file)) if (related.isTest) tests.add(related.path);
	}
	return [...tests].sort();
}
