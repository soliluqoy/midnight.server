import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { readGitSnapshot } from "../git-status.ts";
import {
	candidateIdentity,
	currentText,
	fileStamp,
	owningRepository,
	pendingGit,
	repositoryStamp,
} from "../session-pending-io.ts";

export type Arguments = Record<string, unknown>;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const PAGE_BYTES = 48 * 1024;

export function object(value: unknown): Arguments {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
	return value as Arguments;
}

export function stringArgument(args: Arguments, name: string, fallback?: string): string {
	const value = args[name] ?? fallback;
	if (typeof value !== "string" || !value || value.includes("\0"))
		throw new Error(`${name} must be a nonempty string.`);
	return value;
}

function integerArgument(args: Arguments, name: string, fallback: number, min: number, max: number): number {
	const value = args[name] ?? fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
		throw new Error(`${name} must be an integer from ${min} to ${max}.`);
	return value;
}

export function cleanText(text: string): string {
	return stripVTControlCharacters(text)
		.replace(/\r\n?/g, "\n")
		.replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" || char === "\t" ? char : ""));
}

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function location(args: Arguments): Promise<{ cwd: string; target: string }> {
	const requested = stringArgument(args, "cwd");
	if (!path.isAbsolute(requested)) throw new Error("cwd must be an absolute project directory.");
	const cwd = await realpath(requested);
	if (!(await stat(cwd)).isDirectory()) throw new Error("cwd must be a directory.");
	const target = path.resolve(cwd, stringArgument(args, "path", "."));
	if (!inside(cwd, target) || !inside(cwd, await candidateIdentity(target)))
		throw new Error("Path leaves cwd. To browse another project, explicitly use that directory as cwd.");
	return { cwd, target };
}

function page<T>(items: T[], args: Arguments) {
	const offset = integerArgument(args, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
	const limit = integerArgument(args, "limit", 100, 1, 500);
	const selected: T[] = [];
	let bytes = 2;
	for (const item of items.slice(offset, offset + limit)) {
		bytes += Buffer.byteLength(JSON.stringify(item), "utf8") + (selected.length ? 1 : 0);
		if (bytes > PAGE_BYTES) {
			if (!selected.length) throw new Error("One entry exceeds the 48 KiB display limit.");
			break;
		}
		selected.push(item);
	}
	const end = offset + selected.length;
	return { items: selected, total: items.length, offset, nextOffset: end < items.length ? end : null };
}

export async function workspaceStatus(args: Arguments, signal: AbortSignal) {
	const { cwd } = await location(args);
	signal.throwIfAborted();
	const snapshot = await readGitSnapshot(cwd, "", signal);
	signal.throwIfAborted();
	if (!snapshot)
		return {
			cwd,
			available: false as const,
			message: "Git status unavailable (non-Git folder, Git failure, or concurrent change).",
		};
	return {
		cwd,
		available: true as const,
		repository: snapshot.root,
		branch: snapshot.branch,
		summary: snapshot.summary,
		scope: "Current changes in this repository, including pre-existing changes; not session attribution.",
		...page(
			snapshot.paths
				.filter((entry) => entry.kind !== "!")
				.map(({ path: file, oldPath, code }) => ({ path: file, oldPath, code })),
			args,
		),
	};
}

export async function listDirectory(args: Arguments, signal: AbortSignal) {
	const { cwd, target } = await location(args);
	const directory = await realpath(target);
	if (!inside(cwd, directory)) throw new Error("Directory symlink leaves cwd.");
	signal.throwIfAborted();
	const entries = await readdir(directory, { withFileTypes: true });
	signal.throwIfAborted();
	entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || collator.compare(a.name, b.name));
	return {
		cwd,
		directory,
		...page(
			entries.map((entry) => ({
				name: entry.name,
				path: path.relative(cwd, path.join(directory, entry.name)),
				type: entry.isSymbolicLink()
					? "symlink"
					: entry.isDirectory()
						? "directory"
						: entry.isFile()
							? "file"
							: "other",
			})),
			args,
		),
	};
}

function textPage(text: string, args: Arguments) {
	const lines = cleanText(text).split("\n");
	if (lines.at(-1) === "") lines.pop();
	return page(
		lines.map((text, index) => ({ line: index + 1, text })),
		args,
	);
}

export async function previewFile(args: Arguments, signal: AbortSignal) {
	const { cwd, target } = await location(args);
	signal.throwIfAborted();
	const before = await fileStamp(target);
	const text = await currentText(target);
	if (before !== (await fileStamp(target))) throw new Error("File changed while reading; request a fresh preview.");
	signal.throwIfAborted();
	return { cwd, path: path.relative(cwd, target), ...textPage(text, args) };
}

export async function fileDiff(args: Arguments, signal: AbortSignal) {
	const { cwd, target } = await location(args);
	const layer = stringArgument(args, "layer", "unstaged");
	if (layer !== "staged" && layer !== "unstaged") throw new Error("layer must be staged or unstaged.");
	const repository = await owningRepository(target, signal);
	if (!repository) throw new Error("No Git baseline for this file; use preview instead.");
	const file = path.relative(repository, target).split(path.sep).join("/");
	const snapshot = await readGitSnapshot(repository, "", signal);
	if (!snapshot) throw new Error("Git status unavailable; request a fresh diff.");
	const entry = snapshot.paths.find(
		(entry) =>
			entry.path === file || entry.oldPath === file || (entry.kind === "!" && file.startsWith(`${entry.path}/`)),
	);
	if (entry?.kind === "u") throw new Error("Unresolved conflict; a two-way diff would be incomplete.");
	if (entry?.kind === "!") throw new Error("Ignored file has no reliable Git baseline; use preview instead.");
	if (entry?.metadata[3]?.startsWith("S")) throw new Error("Submodule changes are not previewed.");
	const observed = [
		...new Set([
			target,
			...(entry ? [path.resolve(repository, entry.path)] : []),
			...(entry?.oldPath ? [path.resolve(repository, entry.oldPath)] : []),
		]),
	];
	const before = await Promise.all(observed.map(fileStamp));
	let patch: string;
	let comparison = layer === "staged" ? "HEAD -> index (empty tree before first commit)" : "index -> working tree";
	if (entry?.kind === "?" && layer === "unstaged") {
		const text = await currentText(target);
		const lines = text.split("\n");
		if (lines.at(-1) === "") lines.pop();
		patch = lines.map((line) => `+${line}`).join("\n");
		if (text && !text.endsWith("\n")) patch += "\n\\ No newline at end of file";
		comparison = "empty -> untracked file (current content)";
	} else {
		patch = await pendingGit(
			repository,
			[
				"diff",
				"--no-ext-diff",
				"--no-textconv",
				"--no-color",
				"--find-renames",
				...(layer === "staged" ? ["--cached"] : []),
				"--",
				entry?.path ?? file,
				...(entry?.oldPath ? [entry.oldPath] : []),
			],
			signal,
		);
	}
	const after = await Promise.all(observed.map(fileStamp));
	if (
		before.some((stamp, index) => stamp !== after[index]) ||
		snapshot.repositoryStamp !== (await repositoryStamp(repository, signal))
	)
		throw new Error("File or Git state changed while reading; request a fresh diff.");
	signal.throwIfAborted();
	return { cwd, repository, path: file, layer, comparison, ...textPage(patch, args) };
}

export const operations = {
	midnight_status: workspaceStatus,
	midnight_list: listDirectory,
	midnight_preview: previewFile,
	midnight_diff: fileDiff,
};

export async function callTool(name: string, value: unknown, signal: AbortSignal) {
	if (!Object.hasOwn(operations, name)) throw new Error(`Unknown Midnight tool: ${name}`);
	const args = object(value);
	const allowed = [
		"cwd",
		"offset",
		"limit",
		...(name === "midnight_status" ? [] : ["path"]),
		...(name === "midnight_diff" ? ["layer"] : []),
	];
	for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error(`Unknown argument: ${key}`);
	integerArgument(args, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
	integerArgument(args, "limit", 100, 1, 500);
	if (name === "midnight_preview" || name === "midnight_diff") stringArgument(args, "path");
	return operations[name as keyof typeof operations](args, signal);
}
