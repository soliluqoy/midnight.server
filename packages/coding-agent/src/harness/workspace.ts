import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, posix, relative, resolve, sep } from "node:path";
import { languageOf, relativeImports } from "./outline.ts";

/**
 * The workspace's file list and the tests related to a change. Nothing here reads a file
 * except the candidate tests of a changed source file, and only when a check asks for them.
 */

const MAX_FILES = 20_000;
const MAX_TEST_BYTES = 512_000;
/** Related tests reported per changed file. */
const MAX_TESTS_PER_FILE = 6;

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

/** A test named as one (`a.test.ts`, `test_a.py`, `a_test.go`), not only placed in a test directory. */
function isNamedTestPath(path: string): boolean {
	return (
		/\.(test|spec)\.[a-z]+$/.test(path) ||
		/(^|\/)test_[^/]+\.py$/.test(path) ||
		/_test\.(py|go)$/.test(path) ||
		/(^|\/)test\.[a-z]+$/.test(path)
	);
}

/**
 * Test files a runner can be given. In a directory whose tests are named as tests, the other files
 * are helpers and scripts, such as a fixture module or an interactive key tester that waits for
 * input forever; only directories without named tests (`test/a.js`) count every file as a test.
 */
function runnableTests(files: readonly string[]): Set<string> {
	const namedDirs = new Set(files.filter(isNamedTestPath).map((path) => posix.dirname(path)));
	return new Set(
		files.filter((path) => isTestPath(path) && (isNamedTestPath(path) || !namedDirs.has(posix.dirname(path)))),
	);
}

/**
 * A directory that is not a project: the home directory or a filesystem root. Listing one walks
 * thousands of unrelated files (AppData, caches, downloads).
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
			.filter((path) => !isGeneratedPath(path));
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

function stem(path: string): string {
	return basename(path)
		.replace(/\.[^.]+$/, "")
		.replace(/\.(test|spec)$/, "")
		.replace(/^test_/, "")
		.replace(/_test$/, "");
}

/** Resolve a relative import specifier in `from` to a workspace file. */
export function resolveImport(files: ReadonlySet<string>, from: string, specifier: string): string | undefined {
	if (languageOf(from) === "py") {
		const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
		let base = dirname(from);
		for (let level = 1; level < dots; level++) base = dirname(base);
		const rest = specifier.slice(dots).split(".").filter(Boolean).join("/");
		const candidates = dots > 0 ? [posix.join(base, rest)] : [rest, posix.join(dirname(from), rest)];
		for (const candidate of candidates) {
			for (const path of [`${candidate}.py`, `${candidate}/__init__.py`]) if (files.has(path)) return path;
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
		if (files.has(candidate)) return candidate;
	}
	return undefined;
}

async function readTest(root: string, path: string): Promise<string | undefined> {
	try {
		const absolute = join(root, path);
		if ((await stat(absolute)).size > MAX_TEST_BYTES) return undefined;
		const raw = await readFile(absolute);
		return raw.subarray(0, 4000).includes(0) ? undefined : raw.toString("utf8");
	} catch {
		return undefined;
	}
}

/**
 * Test files related to `changed`: changed tests themselves, and for each changed source file (or
 * test helper) the tests with the same stem or that import it. Only test files in the same language
 * are read.
 */
export async function testsFor(root: string, files: readonly string[], changed: readonly string[]): Promise<string[]> {
	const all = new Set(files);
	const runnable = runnableTests(files);
	const tests = new Set<string>();
	const sources = changed.filter((path) => all.has(path) && languageOf(path) !== "other");
	for (const path of sources) if (runnable.has(path)) tests.add(path);
	const pending = sources.filter((path) => !runnable.has(path));
	if (pending.length === 0) return [...tests].sort();
	const languages = new Set(pending.map(languageOf));
	const candidates = files.filter((path) => runnable.has(path) && languages.has(languageOf(path)));
	const imports = new Map<string, string[]>();
	for (const source of pending) {
		const found: string[] = [];
		for (const test of candidates) {
			if (found.length >= MAX_TESTS_PER_FILE) break;
			if (languageOf(test) !== languageOf(source)) continue;
			if (stem(test) === stem(source)) {
				found.push(test);
				continue;
			}
			let resolved = imports.get(test);
			if (!resolved) {
				const text = await readTest(root, test);
				resolved = text
					? relativeImports(test, text).flatMap((specifier) => resolveImport(all, test, specifier) ?? [])
					: [];
				imports.set(test, resolved);
			}
			if (resolved.includes(source)) found.push(test);
		}
		for (const test of found) tests.add(test);
	}
	return [...tests].sort();
}
