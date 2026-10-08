import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export const MAX_PENDING_BYTES = 1024 * 1024;
export const MAX_PENDING_LINES = 20_000;

/** Report failures as errors, not empty output. Commands only read, with time and output limits. */
export function pendingGit(
	cwd: string,
	args: string[],
	signal: AbortSignal,
	maxBuffer = MAX_PENDING_BYTES,
): Promise<string> {
	return new Promise((accept, reject) => {
		execFile(
			"git",
			["--no-optional-locks", "--literal-pathspecs", ...args],
			{
				cwd,
				encoding: "utf8",
				windowsHide: true,
				timeout: 5000,
				maxBuffer,
				signal,
			},
			(error, stdout, stderr) => {
				// For this command, exit code 1 means HEAD is missing (no first commit yet).
				if (error?.code === 1 && args.join(" ") === "rev-parse --verify --quiet HEAD") {
					accept("<unborn>");
					return;
				}
				if (error)
					reject(
						new Error(
							error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
								? "Output exceeds preview limit (1 MiB)."
								: `Git unavailable: ${stderr.trim() || error.message}`,
						),
					);
				else accept(stdout);
			},
		);
	});
}

export async function fileStamp(path: string): Promise<string> {
	try {
		const stat = await lstat(path, { bigint: true });
		return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
		throw error;
	}
}

/** Find the real parent path, but do not follow a link at the file itself. */
export async function candidateIdentity(file: string): Promise<string> {
	try {
		const stat = await lstat(file);
		// Use the disk's letter case. Lowercasing could mix up two different files.
		if (!stat.isSymbolicLink()) return await realpath(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	let parent = dirname(file);
	const tail = [basename(file)];
	while ((await fileStamp(parent)) === "absent") {
		tail.unshift(basename(parent));
		const next = dirname(parent);
		if (next === parent) break;
		parent = next;
	}
	return resolve(await realpath(parent), ...tail);
}

/** For deleted files, start at the nearest parent that still exists. Do not scan subfolders. */
export async function owningRepository(path: string, signal: AbortSignal): Promise<string | undefined> {
	let parent = dirname(path);
	while ((await fileStamp(parent)) === "absent") {
		const next = dirname(parent);
		if (next === parent) return undefined;
		parent = next;
	}
	try {
		return await realpath((await pendingGit(parent, ["rev-parse", "--show-toplevel"], signal)).replace(/\r?\n$/, ""));
	} catch (error) {
		if (error instanceof Error && error.message.includes("not a git repository")) return undefined;
		throw error;
	}
}

/** Check HEAD, index, and file stamps for other edits. This is not a locked snapshot. */
export async function repositoryStamp(root: string, signal: AbortSignal): Promise<string> {
	// Ask for one path at a time so newlines in paths stay intact, including worktree paths.
	const index = (await pendingGit(root, ["rev-parse", "--git-path", "index"], signal)).replace(/\r?\n$/, "");
	const head = await pendingGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"], signal);
	const absoluteIndex = resolve(root, index);
	return `${absoluteIndex}\0${head}\0${await fileStamp(absoluteIndex)}`;
}

/** Limit memory and bytes read. Skip links and special files before opening. */
export async function currentText(path: string): Promise<string> {
	const before = await lstat(path);
	if (!before.isFile() || before.isSymbolicLink())
		throw new Error("Symlink or unsupported file type; counts unavailable.");
	if (before.size > MAX_PENDING_BYTES) throw new Error("Too large to preview (limit: 1 MiB).");
	const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev)
			throw new Error("File changed while opening.");
		const buffer = Buffer.alloc(MAX_PENDING_BYTES + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const next = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
			if (!next.bytesRead) break;
			bytesRead += next.bytesRead;
		}
		if (bytesRead > MAX_PENDING_BYTES) throw new Error("Too large to preview (limit: 1 MiB).");
		const bytes = buffer.subarray(0, bytesRead);
		if (bytes.includes(0)) throw new Error("Binary content; counts unavailable.");
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (text.split("\n").length > MAX_PENDING_LINES) throw new Error("Too many source lines (limit: 20,000).");
		return text;
	} finally {
		await file.close();
	}
}
