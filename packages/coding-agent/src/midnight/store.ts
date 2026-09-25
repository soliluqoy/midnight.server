import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
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
import { cpuBackend, type EngineLock, engineDownloadBytes, engineLock, MODEL_LOCK, modelDownloadUrl } from "./pins.ts";

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

/** Written last into an installed engine: which pinned build it holds and where llama-server is. */
export const ENGINE_MARKER = ".midnight-engine.json";

interface EngineMarker {
	name: string;
	release: string;
	platform: string;
	backend: string;
	sha256: string[];
	/** llama-server, relative to the install root. */
	server: string;
}

export function serverFileName(platform: string = process.platform): string {
	return platform.startsWith("win32") ? "llama-server.exe" : "llama-server";
}

/** The directory holding llama-server if `root` holds exactly the pinned build `lock`, else undefined. */
export function installedEngineDir(root: string, lock: EngineLock): string | undefined {
	let marker: Partial<EngineMarker>;
	try {
		marker = JSON.parse(readFileSync(join(root, ENGINE_MARKER), "utf8")) as Partial<EngineMarker>;
	} catch {
		return undefined;
	}
	if (
		marker.release !== lock.release ||
		marker.platform !== lock.platform ||
		marker.backend !== lock.backend ||
		marker.sha256?.join() !== lock.archives.map((archive) => archive.sha256).join() ||
		typeof marker.server !== "string"
	) {
		return undefined;
	}
	const server = resolve(root, marker.server);
	if (relative(root, server).startsWith("..") || !existsSync(server)) return undefined;
	return dirname(server);
}

/**
 * Directory of llama-server for `lock`. `MIDNIGHT_SERVER_ENGINE_DIR` names the
 * user's own llama.cpp build and wins over every pinned build.
 */
export function findEngineDir(lock: EngineLock | undefined = engineLock(cpuBackend())): string | undefined {
	const override = process.env.MIDNIGHT_SERVER_ENGINE_DIR;
	if (override) {
		const dir = resolve(override);
		return existsSync(join(dir, serverFileName())) ? dir : undefined;
	}
	if (!lock) return undefined;
	for (const root of engineDirCandidates(lock)) {
		const dir = installedEngineDir(root, lock);
		if (dir) return dir;
	}
	return undefined;
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

/** Linux and macOS archives wrap everything in one top-level directory; Windows zips are flat. */
async function archiveRoot(dir: string): Promise<string> {
	const entries = await readdir(dir, { withFileTypes: true });
	return entries.length === 1 && entries[0].isDirectory() ? join(dir, entries[0].name) : dir;
}

/** Move `from`'s contents into `to`, merging directories and replacing files (a CUDA runtime archive adds libraries). */
async function mergeInto(from: string, to: string): Promise<void> {
	for (const entry of await readdir(from, { withFileTypes: true })) {
		const source = join(from, entry.name);
		const target = join(to, entry.name);
		const existing = await lstat(target).catch(() => undefined);
		if (entry.isDirectory() && existing?.isDirectory()) {
			await mergeInto(source, target);
			continue;
		}
		await rm(target, { recursive: true, force: true });
		await rename(source, target);
	}
}

async function findFile(root: string, name: string, depth = 3): Promise<string | undefined> {
	const entries = await readdir(root, { withFileTypes: true });
	if (entries.some((entry) => entry.isFile() && entry.name === name)) return join(root, name);
	if (depth === 0) return undefined;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const found = await findFile(join(root, entry.name), name, depth - 1);
		if (found) return found;
	}
	return undefined;
}

/**
 * Release archives also carry llama.cpp's other tools (CLI, quantizer, bench,
 * tests). Remove them and their `*-impl` libraries from the server's directory;
 * shared ggml/llama libraries, runtimes and licenses stay.
 */
async function removeOtherTools(serverDir: string, serverName: string): Promise<void> {
	for (const entry of await readdir(serverDir, { withFileTypes: true })) {
		if (!entry.isFile() || entry.name === serverName) continue;
		const path = join(serverDir, entry.name);
		const impl = /^(?:lib)?llama-(.+)-impl\.(?:dll|so|dylib)$/.exec(entry.name);
		const windowsTool = entry.name.endsWith(".exe");
		const unixTool =
			!entry.name.includes(".") && !entry.name.startsWith("LICENSE") && ((await stat(path)).mode & 0o111) !== 0;
		if ((impl && impl[1] !== "server") || windowsTool || unixTool) await rm(path, { force: true });
	}
}

function tarCommand(): string {
	// bsdtar ships with Windows 10 and later and reads both .zip and .tar.gz.
	return process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

/**
 * Download every archive of a pinned engine build, verify each, and extract
 * them into one directory. The install is staged and renamed into place, with
 * the marker written last, so a partial install is never found.
 */
export async function fetchEngine(lock: EngineLock, options: DownloadOptions = {}): Promise<string> {
	const dest = userEngineDir(lock);
	if (installedEngineDir(dest, lock)) return dest;
	const totalBytes = engineDownloadBytes(lock);
	const downloads: string[] = [];
	const staging = `${dest}.${process.pid}.tmp`;
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { recursive: true });
	try {
		let doneBytes = 0;
		for (const [index, archive] of lock.archives.entries()) {
			const file = join(getMidnightHome(), "downloads", basename(new URL(archive.url).pathname));
			downloads.push(file);
			if (!existsSync(file)) {
				await downloadVerified(archive.url, file, archive, {
					...options,
					onProgress: options.onProgress
						? ({ receivedBytes }) =>
								options.onProgress?.({ receivedBytes: doneBytes + receivedBytes, totalBytes })
						: undefined,
				});
			}
			doneBytes += archive.sizeBytes;
			const unpack = `${staging}.${index}`;
			await rm(unpack, { recursive: true, force: true });
			await mkdir(unpack, { recursive: true });
			try {
				await run(tarCommand(), ["-xf", file, "-C", unpack]);
				await mergeInto(await archiveRoot(unpack), staging);
			} finally {
				await rm(unpack, { recursive: true, force: true });
			}
		}
		const serverName = serverFileName(lock.platform);
		const server = await findFile(staging, serverName);
		if (!server) throw new Error(`Engine archives for ${lock.platform}-${lock.backend} do not contain ${serverName}`);
		await removeOtherTools(dirname(server), serverName);
		const marker: EngineMarker = {
			name: lock.name,
			release: lock.release,
			platform: lock.platform,
			backend: lock.backend,
			sha256: lock.archives.map((archive) => archive.sha256),
			server: relative(staging, server).replaceAll("\\", "/"),
		};
		await writeFile(join(staging, ENGINE_MARKER), `${JSON.stringify(marker, null, "\t")}\n`);
		await rm(dest, { recursive: true, force: true });
		await rename(staging, dest);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
	for (const file of downloads) await rm(file, { force: true });
	return dest;
}
