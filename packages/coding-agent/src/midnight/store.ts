import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type DownloadOptions, downloadVerified } from "./download.ts";
import { type ModelLock, verifyModelFile } from "./model-integrity.ts";
import {
	engineDirCandidates,
	getMidnightHome,
	hostCandidates,
	modelCandidates,
	userEngineDir,
	userModelPath,
} from "./paths.ts";
import { ENGINE_LOCK, type EngineLock, MODEL_LOCK, modelDownloadUrl } from "./pins.ts";

interface VerificationStamp {
	sizeBytes: number;
	mtimeMs: number;
	sha256: string;
}

function stampsPath(): string {
	return join(getMidnightHome(), "state", "verified-models.json");
}

async function readStamps(): Promise<Record<string, VerificationStamp>> {
	try {
		const value: unknown = JSON.parse(await readFile(stampsPath(), "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, VerificationStamp>)
			: {};
	} catch {
		return {};
	}
}

async function writeStamp(path: string, lock: ModelLock): Promise<void> {
	const info = await stat(path);
	const stamps = await readStamps();
	stamps[path] = { sizeBytes: info.size, mtimeMs: info.mtimeMs, sha256: lock.sha256 };
	await mkdir(join(getMidnightHome(), "state"), { recursive: true });
	const temp = `${stampsPath()}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(stamps, null, "\t")}\n`);
	await rename(temp, stampsPath());
}

export function findModel(lock: ModelLock = MODEL_LOCK): string | undefined {
	return modelCandidates(lock.fileName).find((path) => existsSync(path));
}

/**
 * Verify the model unless this exact file (path, size, mtime) was already
 * verified against the same pinned hash. A changed or replaced file is re-hashed.
 */
export async function ensureModelVerified(
	path: string,
	lock: ModelLock = MODEL_LOCK,
	options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<"cached" | "verified"> {
	const info = await stat(path);
	const stamp = (await readStamps())[path];
	if (
		!options.force &&
		stamp &&
		stamp.sha256 === lock.sha256 &&
		stamp.sizeBytes === info.size &&
		stamp.mtimeMs === info.mtimeMs &&
		info.size === lock.sizeBytes
	) {
		return "cached";
	}
	await verifyModelFile(path, lock, options.signal);
	await writeStamp(path, lock);
	return "verified";
}

export async function fetchModel(lock: ModelLock = MODEL_LOCK, options: DownloadOptions = {}): Promise<string> {
	const dest = userModelPath(lock.fileName);
	if (!existsSync(dest)) {
		await downloadVerified(modelDownloadUrl(lock), dest, lock, options);
	}
	await ensureModelVerified(dest, lock, { signal: options.signal });
	return dest;
}

export function isCompleteEngineDir(dir: string, lock: EngineLock = ENGINE_LOCK): boolean {
	return lock.files.every((file) => existsSync(join(dir, file)));
}

export function findEngineDir(lock: EngineLock = ENGINE_LOCK): string | undefined {
	return engineDirCandidates().find((dir) => isCompleteEngineDir(dir, lock));
}

export function findHost(): string | undefined {
	return hostCandidates().find((path) => existsSync(path));
}

function run(command: string, args: string[]): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("exit", (code) =>
			code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`)),
		);
	});
}

/**
 * Download the pinned engine archive, verify it, and extract only the runtime
 * files listed in the lock. Uses the bsdtar shipped with Windows 10 and later.
 */
export async function fetchEngine(lock: EngineLock = ENGINE_LOCK, options: DownloadOptions = {}): Promise<string> {
	const dest = userEngineDir();
	if (isCompleteEngineDir(dest, lock)) return dest;
	const archive = join(getMidnightHome(), "downloads", basename(new URL(lock.url).pathname));
	if (!existsSync(archive)) {
		await downloadVerified(lock.url, archive, lock, options);
	}
	const staging = `${dest}.${process.pid}.tmp`;
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { recursive: true });
	const tar =
		process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
	await run(tar, ["-xf", archive, "-C", staging, ...lock.files]);
	if (!isCompleteEngineDir(staging, lock)) {
		await rm(staging, { recursive: true, force: true });
		throw new Error(`Engine archive is missing required files: ${archive}`);
	}
	await rm(dest, { recursive: true, force: true });
	await rename(staging, dest);
	await rm(archive, { force: true });
	return dest;
}
