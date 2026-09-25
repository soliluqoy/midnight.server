import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineLock } from "../src/midnight/pins.ts";

const fetchModel = vi.fn();
const fetchEngine = vi.fn();
const findModel = vi.fn();
const findEngineDir = vi.fn();
const findHost = vi.fn();
const ensureModelVerified = vi.fn();

vi.mock("../src/midnight/store.ts", () => ({
	fetchModel: (...args: unknown[]) => fetchModel(...args),
	fetchEngine: (...args: unknown[]) => fetchEngine(...args),
	findModel: (...args: unknown[]) => findModel(...args),
	findEngineDir: (...args: unknown[]) => findEngineDir(...args),
	findHost: (...args: unknown[]) => findHost(...args),
	ensureModelVerified: (...args: unknown[]) => ensureModelVerified(...args),
}));

const { resolveLocalAssets, LocalSetupError } = await import("../src/midnight/engine-manager.ts");

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
	backend: "cpu",
	platform: "win32-x64",
	url: "http://127.0.0.1:0/engine.zip",
	sizeBytes: 10,
	sha256: "b".repeat(64),
	files: ["a.exe"],
};

const savedEnv = { ...process.env };

beforeEach(() => {
	fetchModel.mockReset();
	fetchEngine.mockReset();
	findModel.mockReset();
	findEngineDir.mockReset();
	findHost.mockReset().mockReturnValue("C:\\install\\engine\\midnight-host.exe");
	ensureModelVerified.mockReset().mockResolvedValue("verified");
});

afterEach(() => {
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
});

describe("resolveLocalAssets", () => {
	it("downloads the model automatically when it is missing and no override is set", async () => {
		findModel.mockReturnValueOnce(undefined);
		fetchModel.mockResolvedValueOnce("C:\\models\\model.gguf");
		findEngineDir.mockReturnValueOnce("C:\\engine");
		const statuses: string[] = [];
		const assets = await resolveLocalAssets(undefined, (message) => statuses.push(message), {
			model: modelLock,
			engine: engineLock,
		});
		expect(assets.modelPath).toBe("C:\\models\\model.gguf");
		expect(fetchModel).toHaveBeenCalledWith(modelLock, expect.objectContaining({}));
		expect(statuses.some((message) => message.includes("Downloading the local model"))).toBe(true);
	});

	it("fails closed instead of downloading past an explicit MIDNIGHT_SERVER_MODEL override", async () => {
		process.env.MIDNIGHT_SERVER_MODEL = "C:\\nowhere.gguf";
		await expect(resolveLocalAssets(undefined, undefined, { model: modelLock, engine: engineLock })).rejects.toThrow(
			/MIDNIGHT_SERVER_MODEL/,
		);
		expect(fetchModel).not.toHaveBeenCalled();
	});

	it("fails closed instead of downloading past an explicit MIDNIGHT_SERVER_ENGINE_DIR override", async () => {
		process.env.MIDNIGHT_SERVER_ENGINE_DIR = "C:\\nowhere";
		findModel.mockReturnValueOnce("C:\\models\\model.gguf");
		findEngineDir.mockReturnValueOnce(undefined);
		await expect(resolveLocalAssets(undefined, undefined, { model: modelLock, engine: engineLock })).rejects.toThrow(
			/MIDNIGHT_SERVER_ENGINE_DIR/,
		);
		expect(fetchEngine).not.toHaveBeenCalled();
	});

	it.runIf(process.platform === "win32" && process.arch === "x64")(
		"downloads the engine automatically when missing, no override, on the supported platform",
		async () => {
			findModel.mockReturnValueOnce("C:\\models\\model.gguf");
			findEngineDir.mockReturnValueOnce(undefined);
			fetchEngine.mockResolvedValueOnce("C:\\engine");
			const assets = await resolveLocalAssets(undefined, undefined, { model: modelLock, engine: engineLock });
			expect(assets.engineDir).toBe("C:\\engine");
			expect(fetchEngine).toHaveBeenCalledWith(engineLock, expect.objectContaining({}));
		},
	);

	it("wraps a download failure in a LocalSetupError with manual-fetch guidance", async () => {
		findModel.mockReturnValueOnce(undefined);
		fetchModel.mockRejectedValueOnce(new Error("network down"));
		const error = await resolveLocalAssets(undefined, undefined, { model: modelLock, engine: engineLock }).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(LocalSetupError);
		expect((error as Error).message).toMatch(/model fetch/);
	});
});
