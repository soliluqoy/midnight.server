import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export interface ExpectedArtifact {
	sizeBytes: number;
	sha256: string;
}

export interface DownloadProgress {
	receivedBytes: number;
	totalBytes: number;
}

export interface DownloadOptions {
	signal?: AbortSignal;
	onProgress?: (progress: DownloadProgress) => void;
	fetchImpl?: typeof fetch;
}

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Exclusive per-destination lock. A lock left by a dead process is taken over,
 * so an interrupted download does not block the next attempt.
 */
export async function withFileLock<T>(lockPath: string, run: () => Promise<T>): Promise<T> {
	await mkdir(dirname(lockPath), { recursive: true });
	for (let attempt = 0; ; attempt++) {
		try {
			const handle = await open(lockPath, "wx");
			await handle.writeFile(String(process.pid));
			await handle.close();
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) {
				throw new Error(`Another process is downloading to this location (${lockPath})`, { cause: error });
			}
			const owner = Number.parseInt(await readFile(lockPath, "utf8").catch(() => ""), 10);
			if (Number.isSafeInteger(owner) && owner !== process.pid && isProcessAlive(owner)) {
				throw new Error(`Another process (PID ${owner}) is downloading to this location`);
			}
			await unlink(lockPath).catch(() => {});
		}
	}
	try {
		return await run();
	} finally {
		await unlink(lockPath).catch(() => {});
	}
}

export async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
	return hash.digest("hex");
}

/**
 * Stream `url` into `<dest>.part`, resuming a previous partial download, then
 * check byte count and SHA-256 before atomically renaming it to `dest`.
 * `dest` never exists in a partial or unverified state.
 */
export async function downloadVerified(
	url: string,
	dest: string,
	expected: ExpectedArtifact,
	options: DownloadOptions = {},
): Promise<void> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const part = `${dest}.part`;
	await mkdir(dirname(dest), { recursive: true });

	await withFileLock(`${dest}.lock`, async () => {
		let offset = await fileSize(part);
		if (offset > expected.sizeBytes) {
			await rm(part, { force: true });
			offset = 0;
		}

		if (offset < expected.sizeBytes) {
			const response = await fetchImpl(url, {
				headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
				redirect: "follow",
				signal: options.signal,
			});
			if (response.status === 200 && offset > 0) {
				// Server ignored the range request; start over.
				offset = 0;
			} else if (!(response.status === 206 && offset > 0) && response.status !== 200) {
				throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
			}
			if (!response.body) throw new Error(`Download failed: empty response for ${url}`);

			let received = offset;
			const progress = new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					received += chunk.length;
					if (received > expected.sizeBytes) {
						callback(new Error(`Download exceeded the expected ${expected.sizeBytes} bytes`));
						return;
					}
					options.onProgress?.({ receivedBytes: received, totalBytes: expected.sizeBytes });
					callback(null, chunk);
				},
			});
			await pipeline(
				Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
				progress,
				createWriteStream(part, { flags: offset > 0 ? "a" : "w" }),
				{ signal: options.signal },
			);
		}

		const size = await fileSize(part);
		if (size !== expected.sizeBytes) {
			throw new Error(`Download incomplete: expected ${expected.sizeBytes} bytes, have ${size}. Retry to resume.`);
		}
		const actual = await sha256File(part, options.signal);
		if (actual !== expected.sha256) {
			await rm(part, { force: true });
			throw new Error(`Downloaded file failed SHA-256 verification (expected ${expected.sha256}, got ${actual})`);
		}
		await rename(part, dest);
	});
}
