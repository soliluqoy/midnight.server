import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineArchive, EngineLock } from "../src/midnight/pins.ts";
import { ENGINE_MARKER, fetchEngine, findEngineDir, installedEngineDir } from "../src/midnight/store.ts";

const windows = process.platform === "win32";
const exe = windows ? ".exe" : "";
const lib = windows ? ".dll" : ".so";
const tar = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

/** Build a .tar.gz of `files` under one top-level directory, like llama.cpp's Linux and macOS archives. */
async function archive(dir: string, top: string, files: Record<string, string>, executables: string[] = []) {
	const root = join(dir, "src", top);
	for (const [name, content] of Object.entries(files)) {
		await mkdir(join(root, name, ".."), { recursive: true });
		await writeFile(join(root, name), content);
		if (executables.includes(name)) await chmod(join(root, name), 0o755);
	}
	const path = join(dir, `${top}.tar.gz`);
	const result = spawnSync(tar, ["-czf", path, "-C", join(dir, "src"), top]);
	if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`);
	await rm(join(dir, "src"), { recursive: true, force: true });
	const bytes = await readFile(path);
	const pinned: EngineArchive = {
		url: `https://example.invalid/${top}.tar.gz`,
		sizeBytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
	return { bytes, pinned };
}

describe("fetchEngine", () => {
	const savedEnv = { ...process.env };
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "midnight-engine-store-"));
		process.env.MIDNIGHT_SERVER_HOME = join(dir, "home");
		delete process.env.MIDNIGHT_SERVER_ENGINE_DIR;
	});

	afterEach(async () => {
		for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
		Object.assign(process.env, savedEnv);
		await rm(dir, { recursive: true, force: true });
	});

	it("merges every archive, drops other llama.cpp tools, and marks the install", async () => {
		const tools = [`llama-server${exe}`, `llama-cli${exe}`, `llama-quantize${exe}`];
		const main = await archive(
			dir,
			"llama-b1",
			{
				[`llama-server${exe}`]: "server",
				[`llama-cli${exe}`]: "cli",
				[`llama-quantize${exe}`]: "quantize",
				[`llama-server-impl${lib}`]: "server impl",
				[`llama-cli-impl${lib}`]: "cli impl",
				[`ggml-vulkan${lib}`]: "backend",
				LICENSE: "license",
			},
			tools,
		);
		const runtime = await archive(dir, "cudart-b1", { [`cudart64_12${lib}`]: "cuda runtime" });
		const bodies = new Map([
			[main.pinned.url, main.bytes],
			[runtime.pinned.url, runtime.bytes],
		]);
		const lock: EngineLock = {
			name: "llama.cpp",
			release: "b1",
			commit: "c",
			platform: windows ? "win32-x64" : "linux-x64",
			backend: "cuda-12",
			archives: [main.pinned, runtime.pinned],
		};

		const root = await fetchEngine(lock, {
			fetchImpl: async (url) => new Response(bodies.get(String(url)) ?? null, { status: 200 }),
		});

		const serverDir = installedEngineDir(root, lock);
		expect(serverDir).toBe(root);
		for (const kept of [
			`llama-server${exe}`,
			`llama-server-impl${lib}`,
			`ggml-vulkan${lib}`,
			"LICENSE",
			`cudart64_12${lib}`,
		]) {
			expect(existsSync(join(root, kept)), kept).toBe(true);
		}
		for (const removed of [`llama-cli${exe}`, `llama-quantize${exe}`, `llama-cli-impl${lib}`]) {
			expect(existsSync(join(root, removed)), removed).toBe(false);
		}
		expect(JSON.parse(await readFile(join(root, ENGINE_MARKER), "utf8"))).toMatchObject({
			release: "b1",
			backend: "cuda-12",
			server: `llama-server${exe}`,
		});
		expect(existsSync(join(dir, "home", "downloads", "llama-b1.tar.gz"))).toBe(false);
		expect(findEngineDir(lock)).toBe(root);

		// A different pin (e.g. after a llama.cpp upgrade) does not match the installed marker.
		expect(
			installedEngineDir(root, { ...lock, archives: [{ ...main.pinned, sha256: "0".repeat(64) }] }),
		).toBeUndefined();
	});

	it("rejects archives without llama-server and leaves nothing installed", async () => {
		const main = await archive(dir, "llama-b2", { [`llama-cli${exe}`]: "cli" });
		const lock: EngineLock = {
			name: "llama.cpp",
			release: "b2",
			commit: "c",
			platform: windows ? "win32-x64" : "linux-x64",
			backend: "cpu",
			archives: [main.pinned],
		};
		await expect(
			fetchEngine(lock, { fetchImpl: async () => new Response(main.bytes, { status: 200 }) }),
		).rejects.toThrow(/do not contain llama-server/);
		expect(findEngineDir(lock)).toBeUndefined();
	});

	it("accepts MIDNIGHT_SERVER_ENGINE_DIR only when it holds llama-server", async () => {
		const own = join(dir, "own-build");
		await mkdir(own, { recursive: true });
		process.env.MIDNIGHT_SERVER_ENGINE_DIR = own;
		expect(findEngineDir(undefined)).toBeUndefined();
		await writeFile(join(own, `llama-server${exe}`), "");
		expect(findEngineDir(undefined)).toBe(own);
	});
});
