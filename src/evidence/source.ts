import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { EvidenceSource } from "./model.ts";

export const MAX_SOURCE_BYTES = 1024 * 1024;
export function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function sensitive(path: string): boolean {
	return path
		.split(/[\\/]/)
		.some((part) =>
			/^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.gnupg|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i.test(
				part,
			),
		);
}

export async function readSource(cwd: string, path: string, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const root = await realpath(cwd);
	const requested = resolve(cwd, path);
	if (!inside(resolve(cwd), requested) || sensitive(relative(resolve(cwd), requested)))
		throw new Error("Evidence source must be a non-sensitive file inside the working project.");
	const canonical = await realpath(requested);
	if (!inside(root, canonical) || sensitive(relative(root, canonical)))
		throw new Error("Evidence symlink target must remain inside the project and outside sensitive paths.");
	const metadata = await stat(canonical);
	if (!metadata.isFile() || metadata.size > MAX_SOURCE_BYTES) throw new Error("Evidence requires a file up to 1 MiB.");
	const handle = await open(canonical, "r");
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size > MAX_SOURCE_BYTES) throw new Error("Evidence requires a file up to 1 MiB.");
		const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			signal?.throwIfAborted();
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		const after = await handle.stat();
		if (length > MAX_SOURCE_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
			throw new Error("Evidence source changed while reading or exceeded 1 MiB.");
		const bytes = buffer.subarray(0, length);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (text.includes("\0")) throw new Error("Evidence source must be UTF-8 text, not binary.");
		signal?.throwIfAborted();
		return { path: relative(resolve(cwd), requested), sha256: sha256(bytes), text };
	} finally {
		await handle.close();
	}
}

export async function captureSource(
	cwd: string,
	path: string,
	startLine = 1,
	endLine = startLine,
	signal?: AbortSignal,
): Promise<EvidenceSource> {
	if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine)
		throw new Error("Invalid evidence line range.");
	if (endLine - startLine >= 100) throw new Error("Evidence excerpts are limited to 100 lines.");
	const source = await readSource(cwd, path, signal);
	const lines = source.text.split(/\r?\n/);
	if (endLine > lines.length) throw new Error("Evidence range extends beyond the source.");
	const quote = lines.slice(startLine - 1, endLine).join("\n");
	if (quote.length > 4000) throw new Error("Evidence excerpt exceeds 4000 characters; select a smaller range.");
	return { kind: "file", path: source.path, sha256: source.sha256, startLine, endLine, quote };
}
