import { createHash } from "node:crypto";
import { mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { analyzeLog, type LogAnalysis, MAX_LINES } from "./analysis.ts";

export { MAX_INPUT_BYTES, MAX_LINES } from "./analysis.ts";
export const MAX_FILE_BYTES = 1024 * 1024;
const SECRET_PATH =
	/^(?:\.env(?:\..*)?|\.git|\.pi|\.ssh|\.aws|\.azure|\.npmrc|auth\.json|credentials(?:\..*)?|id_rsa|id_ed25519)$/i;

export interface LogSelection {
	path: string;
	startLine?: number;
	maxLines?: number;
}

export interface PreparedLog extends LogAnalysis {
	project: string;
	source: string;
	snapshot: string;
	sha256: string;
	selectionSha256: string;
	startLine: number;
	endLine: number;
	totalLines: number;
	redacted: boolean;
}

export function redact(text: string, apiKey: string): string {
	let result = apiKey ? text.split(apiKey).join("[REDACTED]") : text;
	result = result
		.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, (match) =>
			match
				.split("\n")
				.map(() => "[REDACTED PRIVATE KEY]")
				.join("\n"),
		)
		.replace(/\b(Bearer|Basic)[ \t]+[A-Za-z0-9+/_.=~-]+/gi, "$1 [REDACTED]")
		.replace(/\b((?:set-)?cookie)[ \t]*:[^\r\n]*/gi, "$1: [REDACTED]")
		.replace(
			/(["']?\b(?:[\w-]{0,128}(?:api[_-]?key|token|secret|password)|authorization|cookie|set-cookie)["']?[ \t]*[:=][ \t]*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
			"$1[REDACTED]",
		)
		.replace(
			/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/g,
			"[REDACTED]",
		)
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
	return result;
}

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function allowedName(path: string): boolean {
	return !path.split(/[\\/]/).some((part) => SECRET_PATH.test(part));
}

export async function prepareLog(
	cwd: string,
	selection: LogSelection,
	apiKey: string,
	signal: AbortSignal,
	snapshotRoot = tmpdir(),
): Promise<PreparedLog> {
	signal.throwIfAborted();
	const root = await realpath(cwd);
	const requested = resolve(root, selection.path);
	if (!inside(root, requested) || !allowedName(relative(root, requested)))
		throw new Error("Choose a non-sensitive log inside the working project.");
	const source = await realpath(requested);
	if (!inside(root, source) || !allowedName(relative(root, source)))
		throw new Error("Log symlinks must stay inside the working project and cannot target sensitive paths.");
	if (![".log", ".txt", ".out"].includes(extname(source).toLowerCase()))
		throw new Error("Expected a .log, .txt, or .out file. Export the relevant command output first.");
	const count = selection.maxLines ?? MAX_LINES;
	if (!Number.isSafeInteger(count) || count < 1 || count > MAX_LINES)
		throw new Error(`maxLines must be between 1 and ${MAX_LINES}.`);
	if (selection.startLine !== undefined && (!Number.isSafeInteger(selection.startLine) || selection.startLine < 1))
		throw new Error("startLine must be a positive line number.");
	const metadata = await stat(source);
	if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES)
		throw new Error("Log must be an ordinary file no larger than 1 MiB. Export a smaller log first.");
	const file = await open(source, "r");
	let bytes: Buffer;
	try {
		const before = await file.stat();
		if (!before.isFile() || before.size > MAX_FILE_BYTES)
			throw new Error("Log must be an ordinary file no larger than 1 MiB. Export a smaller log first.");
		const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			signal.throwIfAborted();
			const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		const after = await file.stat();
		if (
			length > MAX_FILE_BYTES ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			length !== after.size
		)
			throw new Error("Log changed while reading. Wait for the command to finish and retry.");
		bytes = buffer.subarray(0, length);
	} finally {
		await file.close();
	}
	signal.throwIfAborted();
	if (bytes.includes(0)) throw new Error("Binary/UTF-16 logs are unsupported. Export UTF-8 text instead.");
	let original: string;
	try {
		original = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error("Log is not valid UTF-8 text.");
	}
	if (!original.trim()) throw new Error("The log is empty.");
	const lines = original.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const cleanLines = lines.map(stripVTControlCharacters);
	const safeLines = redact(cleanLines.join("\n"), apiKey).split("\n");
	if ((selection.startLine ?? 1) > lines.length) throw new Error("startLine is beyond the end of the log.");
	const analysis = analyzeLog(safeLines, selection.startLine, count);
	const { startLine: scanStart, endLine: scanEnd } = analysis.scannedRange;
	if (
		!safeLines
			.slice(scanStart - 1, scanEnd)
			.join("\n")
			.trim()
	)
		throw new Error("The selected range contains no text.");
	signal.throwIfAborted();
	const directory = await mkdtemp(join(snapshotRoot, "midnight-log-triage-"));
	const snapshot = join(directory, basename(source));
	try {
		await writeFile(snapshot, bytes, { mode: 0o600, signal });
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
	return {
		...analysis,
		project: root,
		source,
		snapshot,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		selectionSha256: createHash("sha256").update(analysis.text).digest("hex"),
		startLine: analysis.selectedRanges[0].startLine,
		endLine: analysis.selectedRanges.at(-1)?.endLine ?? lines.length,
		totalLines: lines.length,
		redacted:
			cleanLines.slice(scanStart - 1, scanEnd).join("\n") !== safeLines.slice(scanStart - 1, scanEnd).join("\n"),
	};
}
