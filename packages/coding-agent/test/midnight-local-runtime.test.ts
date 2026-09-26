import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createInteractiveShellOperations } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ProviderConfigInput } from "../src/core/provider-composer.ts";
import { getDefaultActiveToolNames } from "../src/core/tools/index.ts";
import type { LocalEngine } from "../src/midnight/engine.ts";
import type { EngineManager } from "../src/midnight/engine-manager.ts";
import { LocalSetupError } from "../src/midnight/engine-manager.ts";
import { createLocalProviderExtension } from "../src/midnight/extension.ts";
import {
	LocalInferenceUnavailableError,
	parseMidnightMode,
	prepareLocalRuntime,
} from "../src/midnight/local-runtime.ts";
import { LOCAL_MODEL_ID, LOCAL_PROVIDER_ID, MODEL_LOCK } from "../src/midnight/pins.ts";

const savedEnv = { ...process.env };
afterEach(() => {
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
});

async function unconfiguredModelRuntime(): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
}

async function configuredModelRuntime(): Promise<ModelRuntime> {
	const credentials = AuthStorage.inMemory();
	await credentials.modify("anthropic", async () => ({ type: "api_key", key: "sk-test" }));
	return ModelRuntime.create({
		credentials,
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
}

function fakeManager(): { manager: EngineManager; stops: number[] } {
	const stops: number[] = [];
	const engine = {
		baseUrl: "http://127.0.0.1:1",
		apiKey: "0".repeat(64),
		settings: { contextSize: 8192, threads: 1, gpuLayers: 0, startupTimeoutMs: 1 },
	} as unknown as LocalEngine;
	const manager = {
		get: async () => engine,
		stop: async () => {
			stops.push(1);
		},
	} as unknown as EngineManager;
	return { manager, stops };
}

function fakeManagerThatCannotSetUp(): { manager: EngineManager; stops: number[] } {
	const stops: number[] = [];
	const manager = {
		get: async () => {
			throw new LocalSetupError("model not installed");
		},
		stop: async () => {
			stops.push(1);
		},
	} as unknown as EngineManager;
	return { manager, stops };
}

describe("mode selection", () => {
	it("respects an explicit model choice: no fallback, hybrid extensions still added", async () => {
		const args = ["-p", "hello", "--model", "openai/gpt-4o"];
		const runtime = await prepareLocalRuntime(args, { modelRuntime: await unconfiguredModelRuntime() });
		expect(runtime.mode).toBe("default");
		expect(runtime.args).toEqual(args);
		expect(runtime.extensionFactories.map((factory) => factory.name)).toEqual([
			"midnight-local",
			"midnight-session-title",
			"midnight-delegate",
			"midnight-drift-watch",
		]);
	});

	it("falls back to the local model, silently and switchably, when nothing is configured", async () => {
		const { manager, stops } = fakeManager();
		const runtime = await prepareLocalRuntime(["-p", "hello"], {
			manager,
			modelRuntime: await unconfiguredModelRuntime(),
		});
		expect(runtime.mode).toBe("default");
		expect(runtime.args).toEqual([
			"--provider",
			LOCAL_PROVIDER_ID,
			"--model",
			LOCAL_MODEL_ID,
			"--models",
			`${LOCAL_PROVIDER_ID}/${LOCAL_MODEL_ID}`,
			"-p",
			"hello",
		]);
		expect(runtime.args).not.toContain("--offline");
		expect(runtime.extensionFactories.map((factory) => factory.name)).toEqual([
			"midnight-local",
			"midnight-session-title",
		]);
		await runtime.stop();
		expect(stops).toHaveLength(1);
	});

	it("never starts or downloads the engine for version, help, subcommands, or model listing", async () => {
		let starts = 0;
		const manager = {
			get: async () => {
				starts++;
				throw new Error("engine must not start");
			},
			stop: async () => {},
		} as unknown as EngineManager;
		for (const args of [["--version"], ["-h"], ["--local", "--help"], ["update", "--self"], ["auth", "status"]]) {
			const runtime = await prepareLocalRuntime(args, { manager, modelRuntime: await unconfiguredModelRuntime() });
			expect(runtime.extensionFactories).toEqual([]);
		}
		const listing = await prepareLocalRuntime(["--list-models"], {
			manager,
			modelRuntime: await unconfiguredModelRuntime(),
		});
		expect(listing.args).toEqual(["--list-models"]);
		expect(starts).toBe(0);
	});

	it("does not fall back when a provider is already configured", async () => {
		const runtime = await prepareLocalRuntime(["task"], { modelRuntime: await configuredModelRuntime() });
		expect(runtime.args).toEqual(["task"]);
		expect(runtime.extensionFactories.map((factory) => factory.name)).toEqual([
			"midnight-local",
			"midnight-session-title",
			"midnight-delegate",
			"midnight-drift-watch",
		]);
	});

	it("--hybrid falls back the same way as bare default when nothing is configured", async () => {
		const { manager } = fakeManager();
		const runtime = await prepareLocalRuntime(["--hybrid", "task"], {
			manager,
			modelRuntime: await unconfiguredModelRuntime(),
		});
		expect(runtime.mode).toBe("hybrid");
		expect(runtime.extensionFactories.map((factory) => factory.name)).toEqual([
			"midnight-local",
			"midnight-session-title",
		]);
	});

	it("falls through to ordinary hybrid behavior, without throwing, when the local model isn't installed", async () => {
		const { manager } = fakeManagerThatCannotSetUp();
		const runtime = await prepareLocalRuntime(["task"], {
			manager,
			modelRuntime: await unconfiguredModelRuntime(),
		});
		expect(runtime.args).toEqual(["task"]);
		expect(runtime.extensionFactories.map((factory) => factory.name)).toEqual([
			"midnight-local",
			"midnight-session-title",
			"midnight-delegate",
			"midnight-drift-watch",
		]);
	});

	it("rejects combining --local and --hybrid", () => {
		expect(() => parseMidnightMode(["--local", "--hybrid"])).toThrow(LocalInferenceUnavailableError);
	});

	it.each(["--model", "--provider", "--models", "--api-key"])("rejects %s with --local", async (flag) => {
		const { manager } = fakeManager();
		await expect(prepareLocalRuntime(["--local", flag, "x"], { manager })).rejects.toThrow(
			LocalInferenceUnavailableError,
		);
	});

	it("fails closed, rather than downloading past it, when MIDNIGHT_SERVER_MODEL points at nothing", async () => {
		process.env.MIDNIGHT_SERVER_MODEL = fileURLToPath(new URL("./does-not-exist.gguf", import.meta.url));
		await expect(prepareLocalRuntime(["--local", "private prompt"])).rejects.toThrow(/MIDNIGHT_SERVER_MODEL/);
	});

	it("selects only the embedded model and forces offline startup in local mode", async () => {
		const { manager, stops } = fakeManager();
		const runtime = await prepareLocalRuntime(["--local", "-p", "hello"], { manager });
		expect(runtime.mode).toBe("local");
		expect(runtime.args).toEqual([
			"--offline",
			"--provider",
			LOCAL_PROVIDER_ID,
			"--model",
			LOCAL_MODEL_ID,
			"--models",
			`${LOCAL_PROVIDER_ID}/${LOCAL_MODEL_ID}`,
			"-p",
			"hello",
		]);
		expect(runtime.extensionFactories.map((factory) => factory.name)).toEqual([
			"midnight-local",
			"midnight-session-title",
		]);
		await runtime.stop();
		expect(stops).toHaveLength(1);
	});

	it("adds delegation in hybrid mode without starting the engine", async () => {
		let started = false;
		const manager = {
			get: async () => {
				started = true;
				throw new Error("unexpected start");
			},
			stop: async () => {},
		} as unknown as EngineManager;
		const runtime = await prepareLocalRuntime(["--hybrid", "task"], {
			manager,
			modelRuntime: await configuredModelRuntime(),
		});
		expect(runtime.args).toEqual(["task"]);
		expect(runtime.extensionFactories.map((factory) => factory.name)).toEqual([
			"midnight-local",
			"midnight-session-title",
			"midnight-delegate",
			"midnight-drift-watch",
		]);
		expect(started).toBe(false);
	});
});

describe("local provider", () => {
	it("starts the engine on the first request and sends to its current URL and key", async () => {
		const requests: { url?: string; authorization?: string }[] = [];
		const server = createServer((request, response) => {
			requests.push({ url: request.url, authorization: request.headers.authorization });
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`${chunk({ role: "assistant", content: "hi" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`);
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		try {
			const address = server.address() as AddressInfo;
			let starts = 0;
			const manager = {
				get: async () => {
					starts++;
					return { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "engine-key" } as LocalEngine;
				},
			} as unknown as EngineManager;
			const runtime = await unconfiguredModelRuntime();
			const pi = {
				registerProvider: (id: string, config: ProviderConfigInput) => runtime.registerProvider(id, config),
				registerCommand: () => {},
				on: () => {},
			} as unknown as ExtensionAPI;
			createLocalProviderExtension(manager, { localOnly: false, contextSize: 4096 })(pi);

			const model = runtime.getModel(LOCAL_PROVIDER_ID, LOCAL_MODEL_ID);
			expect(model?.contextWindow).toBe(4096);
			expect(starts).toBe(0);
			const reply = await runtime.completeSimple(model!, {
				messages: [{ role: "user", content: "hello", timestamp: 0 }],
			});
			expect(reply.errorMessage).toBeUndefined();
			expect(reply.content).toEqual([{ type: "text", text: "hi" }]);
			expect(starts).toBe(1);
			expect(requests).toEqual([{ url: "/v1/chat/completions", authorization: "Bearer engine-key" }]);
		} finally {
			server.close();
		}
	});
});

describe("request provider allowlist", () => {
	it("blocks requests to providers outside the allowlist", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const calls: string[] = [];
		for (const id of ["local", "remote"]) {
			runtime.registerProvider(id, {
				baseUrl: "http://127.0.0.1:1/v1",
				apiKey: "key",
				api: "openai-completions",
				streamSimple: (model) => {
					calls.push(model.provider);
					const stream = createAssistantMessageEventStream();
					const message = {
						role: "assistant" as const,
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop" as const,
						timestamp: Date.now(),
					};
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
					return stream;
				},
				models: [
					{
						id: "m",
						name: "m",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1000,
						maxTokens: 100,
					},
				],
			});
		}
		const local = runtime.getModel("local", "m");
		const remote = runtime.getModel("remote", "m");
		expect(local && remote).toBeTruthy();
		runtime.restrictRequestProviders(["local"]);
		const context = { messages: [{ role: "user" as const, content: "secret", timestamp: 0 }] };
		const blocked = await runtime.completeSimple(remote!, context);
		expect(blocked.stopReason).toBe("error");
		expect(blocked.errorMessage).toMatch(/blocked/);
		expect((await runtime.completeSimple(local!, context)).stopReason).toBe("stop");
		expect(calls).toEqual(["local"]);
		runtime.restrictRequestProviders(undefined);
		await runtime.completeSimple(remote!, context);
		expect(calls).toEqual(["local", "remote"]);
	});
});

describe("Windows shell defaults", () => {
	it("uses PowerShell instead of Bash as the default tool on Windows", () => {
		expect(getDefaultActiveToolNames("win32")).toEqual(["read", "powershell", "edit", "write"]);
		expect(getDefaultActiveToolNames("linux")).toEqual(["read", "bash", "edit", "write"]);
	});

	it.runIf(process.platform === "win32")("runs ! commands through PowerShell unless a shellPath is set", async () => {
		const chunks: Buffer[] = [];
		const result = await createInteractiveShellOperations(undefined).exec(
			"$PSVersionTable.PSVersion.Major",
			process.cwd(),
			{
				onData: (data) => chunks.push(data),
			},
		);
		expect(result.exitCode).toBe(0);
		expect(Number(Buffer.concat(chunks).toString().trim())).toBeGreaterThanOrEqual(5);
	});
});

describe("pins", () => {
	it("keeps the compiled model pin equal to the JSON lock used by scripts", () => {
		const modelLock = JSON.parse(
			readFileSync(new URL("../../../models/minicpm5-2b-q8_0.lock.json", import.meta.url), "utf8"),
		);
		expect(modelLock).toEqual(MODEL_LOCK);
	});
});
