import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineLock } from "../src/midnight/pins.ts";

const fetchModel = vi.fn();
const fetchEngine = vi.fn();
const findModel = vi.fn();
const findEngineDir = vi.fn();
const findHost = vi.fn();
const ensureModelVerified = vi.fn();
const installedEngineDir = vi.fn();

vi.mock("../src/midnight/store.ts", () => ({
	fetchModel: (...args: unknown[]) => fetchModel(...args),
	fetchEngine: (...args: unknown[]) => fetchEngine(...args),
	findModel: (...args: unknown[]) => findModel(...args),
	findEngineDir: (...args: unknown[]) => findEngineDir(...args),
	findHost: (...args: unknown[]) => findHost(...args),
	ensureModelVerified: (...args: unknown[]) => ensureModelVerified(...args),
	installedEngineDir: (...args: unknown[]) => installedEngineDir(...args),
	serverFileName: () => "llama-server",
}));

const { resolveModel, resolveEngine, LocalSetupError } = await import("../src/midnight/engine-manager.ts");

const modelLock = {
	modelId: "test/model",
	repository: "test/model-gguf",
	revision: "rev",
	fileName: "model.gguf",
	sizeBytes: 1024,
	sha256: "a".repeat(64),
};

const engineLock: EngineLock = {
	name: "llama.cpp",
	release: "x",
	commit: "c",
	backend: "vulkan",
	platform: "linux-x64",
	archives: [{ url: "http://127.0.0.1:0/engine.tar.gz", sizeBytes: 10, sha256: "b".repeat(64) }],
};

const savedEnv = { ...process.env };

beforeEach(() => {
	fetchModel.mockReset();
	fetchEngine.mockReset();
	findModel.mockReset();
	findEngineDir.mockReset();
	installedEngineDir.mockReset();
	findHost.mockReset().mockReturnValue("C:\\install\\engine\\midnight-host.exe");
	ensureModelVerified.mockReset().mockResolvedValue("verified");
});

afterEach(() => {
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
});

describe("resolveModel", () => {
	it("downloads the model automatically when it is missing and no override is set", async () => {
		findModel.mockReturnValueOnce(undefined);
		fetchModel.mockResolvedValueOnce("C:\\models\\model.gguf");
		const statuses: string[] = [];
		const resolved = await resolveModel(undefined, (message: string) => statuses.push(message), modelLock);
		expect(resolved.modelPath).toBe("C:\\models\\model.gguf");
		expect(fetchModel).toHaveBeenCalledWith(modelLock, expect.objectContaining({}));
		expect(statuses.some((message) => message.includes("Downloading the local model"))).toBe(true);
	});

	it("fails closed instead of downloading past an explicit MIDNIGHT_SERVER_MODEL override", async () => {
		process.env.MIDNIGHT_SERVER_MODEL = "C:\\nowhere.gguf";
		await expect(resolveModel(undefined, undefined, modelLock)).rejects.toThrow(/MIDNIGHT_SERVER_MODEL/);
		expect(fetchModel).not.toHaveBeenCalled();
	});

	it("wraps a download failure in a LocalSetupError with manual-fetch guidance", async () => {
		findModel.mockReturnValueOnce(undefined);
		fetchModel.mockRejectedValueOnce(new Error("network down"));
		const error = await resolveModel(undefined, undefined, modelLock).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(LocalSetupError);
		expect((error as Error).message).toMatch(/model fetch/);
	});
});

describe("resolveEngine", () => {
	it("fails closed instead of downloading past an explicit MIDNIGHT_SERVER_ENGINE_DIR override", async () => {
		process.env.MIDNIGHT_SERVER_ENGINE_DIR = "C:\\nowhere";
		findEngineDir.mockReturnValueOnce(undefined);
		await expect(resolveEngine(engineLock)).rejects.toThrow(/MIDNIGHT_SERVER_ENGINE_DIR/);
		expect(fetchEngine).not.toHaveBeenCalled();
	});

	it("downloads a missing pinned build on any platform and returns its llama-server directory", async () => {
		findEngineDir.mockReturnValueOnce(undefined);
		fetchEngine.mockResolvedValueOnce("/state/engine/root");
		installedEngineDir.mockReturnValueOnce("/state/engine/root/bin");
		await expect(resolveEngine(engineLock)).resolves.toBe("/state/engine/root/bin");
		expect(fetchEngine).toHaveBeenCalledWith(engineLock, expect.objectContaining({}));
	});

	it("names the backend in the manual-fetch guidance when the download fails", async () => {
		findEngineDir.mockReturnValueOnce(undefined);
		fetchEngine.mockRejectedValueOnce(new Error("network down"));
		const error = await resolveEngine(engineLock).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(LocalSetupError);
		expect((error as Error).message).toMatch(/engine fetch vulkan/);
	});

	it("reports an unsupported platform when there is no pinned build", async () => {
		findEngineDir.mockReturnValueOnce(undefined);
		await expect(resolveEngine(undefined)).rejects.toThrow(/No pinned inference engine/);
	});
});
