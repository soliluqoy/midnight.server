import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendChoice } from "../src/midnight/backend.ts";
import { engineLock } from "../src/midnight/pins.ts";

const start = vi.fn();
const readBackendChoice = vi.fn();
const writeBackendChoice = vi.fn();

vi.mock("../src/midnight/engine.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/midnight/engine.ts")>()),
	LocalEngine: { start: (...args: unknown[]) => start(...args) },
}));
vi.mock("../src/midnight/backend.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/midnight/backend.ts")>()),
	readBackendChoice: (...args: unknown[]) => readBackendChoice(...args),
	writeBackendChoice: (...args: unknown[]) => writeBackendChoice(...args),
}));
vi.mock("../src/midnight/store.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/midnight/store.ts")>()),
	findEngineDir: (lock: { backend: string } | undefined) => `/engines/${lock?.backend}`,
}));

const { startSelectedEngine } = await import("../src/midnight/engine-manager.ts");

const savedEnv = { ...process.env };
const context = { model: { modelPath: "/models/model.gguf" } };

function savedChoice(source: BackendChoice["source"]): BackendChoice | undefined {
	const lock = engineLock("vulkan");
	return lock && { ...lock, backend: "vulkan", gpuLayers: 999, source, reason: "measured", decidedAt: "" };
}

beforeEach(() => {
	start.mockReset();
	readBackendChoice.mockReset();
	writeBackendChoice.mockReset().mockResolvedValue(undefined);
	delete process.env.MIDNIGHT_SERVER_BACKEND;
	delete process.env.MIDNIGHT_SERVER_ENGINE_DIR;
});

afterEach(() => {
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
});

describe.runIf(engineLock("vulkan"))("startSelectedEngine", () => {
	it("falls back to the CPU and replaces an automatic GPU choice that no longer starts", async () => {
		readBackendChoice.mockResolvedValue(savedChoice("auto"));
		start
			.mockRejectedValueOnce(new Error("Engine exited during startup (code 1)"))
			.mockResolvedValueOnce("cpu engine");
		const statuses: string[] = [];
		const engine = await startSelectedEngine({ ...context, onStatus: (message) => statuses.push(message) });
		expect(engine).toBe("cpu engine");
		expect(start.mock.calls.map(([options]) => [options.engineDir, options.defaultGpuLayers])).toEqual([
			["/engines/vulkan", 999],
			["/engines/cpu", 0],
		]);
		expect(writeBackendChoice).toHaveBeenCalledWith(expect.objectContaining({ backend: "cpu", gpuLayers: 0 }));
		expect(statuses.some((message) => message.includes("Using the CPU instead"))).toBe(true);
	});

	it("does not fall back from a backend the user chose", async () => {
		readBackendChoice.mockResolvedValue(savedChoice("user"));
		start.mockRejectedValueOnce(new Error("Engine exited during startup (code 1)"));
		await expect(startSelectedEngine(context)).rejects.toThrow(/exited during startup/);
		expect(start).toHaveBeenCalledTimes(1);
		expect(writeBackendChoice).not.toHaveBeenCalled();
	});

	it("does not fall back from MIDNIGHT_SERVER_BACKEND", async () => {
		process.env.MIDNIGHT_SERVER_BACKEND = "vulkan";
		start.mockRejectedValueOnce(new Error("Engine exited during startup (code 1)"));
		await expect(startSelectedEngine(context)).rejects.toThrow(/exited during startup/);
		expect(readBackendChoice).not.toHaveBeenCalled();
		expect(start).toHaveBeenCalledTimes(1);
	});
});
