import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type GpuDevice,
	newChoice,
	type ProbeHooks,
	parseDevices,
	probeBackends,
	readBackendChoice,
	requestedBackend,
	writeBackendChoice,
} from "../src/midnight/backend.ts";
import type { ChatResult } from "../src/midnight/engine.ts";
import { backendChoicePath } from "../src/midnight/paths.ts";
import {
	cpuBackend,
	currentEnginePlatform,
	type EngineLock,
	engineLock,
	MODEL_LOCK,
	parseBackend,
} from "../src/midnight/pins.ts";

describe("parseDevices", () => {
	it("reads llama-server --list-devices output", () => {
		const output = [
			"0.00.001.614 I srv  llama_server: initializing ...",
			"Available devices:",
			"  Vulkan0: Intel(R) UHD Graphics 620 (8129 MiB, 7467 MiB free)",
			"  CUDA1: NVIDIA GeForce RTX 4070 (12281 MiB, 11200 MiB free)",
		].join("\r\n");
		expect(parseDevices(output)).toEqual([
			{ id: "Vulkan0", name: "Intel(R) UHD Graphics 620", totalMiB: 8129, freeMiB: 7467 },
			{ id: "CUDA1", name: "NVIDIA GeForce RTX 4070", totalMiB: 12281, freeMiB: 11200 },
		]);
	});

	it("returns no devices for a CPU-only build", () => {
		expect(parseDevices("Available devices:\n  (none)\n")).toEqual([]);
	});
});

describe("parseBackend", () => {
	it("maps cuda to the platform's oldest CUDA build", () => {
		expect(parseBackend("cuda", "win32-x64")).toBe("cuda-12");
		expect(parseBackend("cuda", "linux-arm64")).toBe("cuda-13");
		expect(parseBackend("cuda", "darwin-arm64")).toBeUndefined();
		expect(parseBackend("metal", "win32-x64")).toBeUndefined();
	});

	it("uses the Metal build as the CPU fallback on Apple Silicon", () => {
		expect(cpuBackend("darwin-arm64")).toBe("metal");
		expect(cpuBackend("linux-x64")).toBe("cpu");
	});
});

interface FakeSpeed {
	promptTps: number;
	genTps: number;
	fails?: boolean;
}

/** Hooks whose engines report fixed speeds per (directory, GPU layers). */
function fakeHooks(options: {
	devices?: GpuDevice[];
	gpu: FakeSpeed;
	cpu: FakeSpeed;
	downloadFails?: boolean;
}): ProbeHooks & { started: string[] } {
	const started: string[] = [];
	return {
		started,
		modelBytes: MODEL_LOCK.sizeBytes,
		ensureEngine: async (lock: EngineLock) => {
			if (options.downloadFails && lock.backend !== "cpu") throw new Error("network down");
			return `/engines/${lock.backend}`;
		},
		listDevices: async () => options.devices ?? [],
		startEngine: async (engineDir: string, gpuLayers: number) => {
			started.push(`${engineDir}@${gpuLayers}`);
			const speed = gpuLayers > 0 ? options.gpu : options.cpu;
			if (speed.fails) throw new Error("Engine exited during startup (code 1)");
			return {
				chat: async (): Promise<ChatResult> => ({
					content: "1, 2, 3",
					finishReason: "length",
					promptTokens: 600,
					completionTokens: 64,
					promptMs: (600 / speed.promptTps) * 1000,
					predictedMs: (64 / speed.genTps) * 1000,
				}),
				stop: async () => {},
			};
		},
	};
}

const bigGpu: GpuDevice = { id: "Vulkan0", name: "Radeon RX 7600", totalMiB: 8176, freeMiB: 7900 };

describe("probeBackends", () => {
	it("keeps the CPU when the integrated GPU is slower overall (measured on an i7-8650U with UHD 620)", async () => {
		const uhd620: GpuDevice = { id: "Vulkan0", name: "Intel(R) UHD Graphics 620", totalMiB: 8129, freeMiB: 7467 };
		const hooks = fakeHooks({
			devices: [uhd620],
			gpu: { promptTps: 25.0, genTps: 3.97 },
			cpu: { promptTps: 20.65, genTps: 8.78 },
		});
		const result = await probeBackends(hooks, "win32-x64");
		expect(result.persist).toBe(true);
		expect(result.choice.backend).toBe("cpu");
		expect(result.choice.gpuLayers).toBe(0);
		expect(result.choice.measurements).toHaveLength(2);
		expect(hooks.started).toEqual(["/engines/vulkan@999", "/engines/cpu@0"]);
	});

	it("picks the GPU when it finishes a typical task clearly sooner", async () => {
		const hooks = fakeHooks({
			devices: [bigGpu],
			gpu: { promptTps: 900, genTps: 60 },
			cpu: { promptTps: 20, genTps: 9 },
		});
		const result = await probeBackends(hooks, "win32-x64");
		expect(result.choice).toMatchObject({ backend: "vulkan", gpuLayers: 999, source: "auto" });
		expect(result.choice.reason).toContain("Radeon RX 7600");
	});

	it("keeps the CPU without measuring when no GPU is found", async () => {
		const hooks = fakeHooks({ gpu: { promptTps: 1, genTps: 1 }, cpu: { promptTps: 20, genTps: 9 } });
		const result = await probeBackends(hooks, "linux-x64");
		expect(result.choice.backend).toBe("cpu");
		expect(result.choice.reason).toMatch(/found no GPU/);
		expect(hooks.started).toEqual([]);
	});

	it("skips GPUs with less memory than the model needs", async () => {
		const small: GpuDevice = { id: "Vulkan0", name: "Old GPU", totalMiB: 2048, freeMiB: 1900 };
		const result = await probeBackends(
			fakeHooks({ devices: [small], gpu: { promptTps: 900, genTps: 60 }, cpu: { promptTps: 20, genTps: 9 } }),
			"win32-x64",
		);
		expect(result.choice.backend).toBe("cpu");
		expect(result.choice.reason).toMatch(/GPU memory below/);
	});

	it("never picks a GPU backend that fails to run the model", async () => {
		const result = await probeBackends(
			fakeHooks({
				devices: [bigGpu],
				gpu: { promptTps: 900, genTps: 60, fails: true },
				cpu: { promptTps: 20, genTps: 9 },
			}),
			"win32-x64",
		);
		expect(result.choice.backend).toBe("cpu");
		expect(result.choice.reason).toMatch(/vulkan engine failed/);
		expect(result.persist).toBe(true);
	});

	it("does not remember a CPU choice caused by a failed download", async () => {
		const result = await probeBackends(
			fakeHooks({
				devices: [bigGpu],
				downloadFails: true,
				gpu: { promptTps: 900, genTps: 60 },
				cpu: { promptTps: 20, genTps: 9 },
			}),
			"win32-x64",
		);
		expect(result.choice.backend).toBe("cpu");
		expect(result.persist).toBe(false);
	});

	it("compares Metal with and without GPU layers on Apple Silicon", async () => {
		const m2: GpuDevice = { id: "MTL0", name: "Apple M2", totalMiB: 10922, freeMiB: 10922 };
		const hooks = fakeHooks({
			devices: [m2],
			gpu: { promptTps: 400, genTps: 40 },
			cpu: { promptTps: 60, genTps: 15 },
		});
		const result = await probeBackends(hooks, "darwin-arm64");
		expect(result.choice).toMatchObject({ backend: "metal", gpuLayers: 999 });
		expect(hooks.started).toEqual(["/engines/metal@999", "/engines/metal@0"]);
	});

	it("uses the CPU where no automatic GPU backend is pinned", async () => {
		const result = await probeBackends(
			fakeHooks({ devices: [bigGpu], gpu: { promptTps: 900, genTps: 60 }, cpu: { promptTps: 20, genTps: 9 } }),
			"darwin-x64",
		);
		expect(result.choice.backend).toBe("cpu");
	});
});

describe("backend choice persistence", () => {
	const savedEnv = { ...process.env };
	let home: string;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "midnight-backend-"));
		process.env.MIDNIGHT_SERVER_HOME = home;
	});

	afterEach(async () => {
		for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
		Object.assign(process.env, savedEnv);
		await rm(home, { recursive: true, force: true });
	});

	const platform = currentEnginePlatform();

	it.runIf(platform)("round-trips a saved choice for this platform", async () => {
		const lock = engineLock(cpuBackend());
		if (!lock) throw new Error("no CPU build for this platform");
		await writeBackendChoice(newChoice(lock, 0, "auto", "test"));
		expect(await readBackendChoice()).toMatchObject({ backend: lock.backend, reason: "test" });
	});

	it("ignores a choice saved for another engine release", async () => {
		const lock = engineLock(cpuBackend());
		if (!lock) return;
		await writeBackendChoice(newChoice({ ...lock, release: "b1" }, 0, "auto", "old"));
		expect(await readBackendChoice()).toBeUndefined();
	});

	it("ignores a corrupt choice file", async () => {
		await writeBackendChoice(newChoice({ ...(engineLock("cpu", "linux-x64") as EngineLock) }, 0, "auto", "x"));
		await writeFile(backendChoicePath(), "{not json");
		expect(await readBackendChoice()).toBeUndefined();
	});

	it("rejects an unknown MIDNIGHT_SERVER_BACKEND with the available names", () => {
		process.env.MIDNIGHT_SERVER_BACKEND = "bogus";
		expect(() => requestedBackend()).toThrow(/Available: auto/);
		process.env.MIDNIGHT_SERVER_BACKEND = "AUTO";
		expect(requestedBackend()).toBe("auto");
	});
});
