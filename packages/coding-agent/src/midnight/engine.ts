import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { availableParallelism } from "node:os";
import { delimiter, dirname, join } from "node:path";

export interface EngineSettings {
	contextSize: number;
	threads: number;
	gpuLayers: number;
	startupTimeoutMs: number;
}

export interface EngineStartOptions extends Partial<EngineSettings> {
	modelPath: string;
	engineDir: string;
	/** GPU layers when neither the options nor MIDNIGHT_SERVER_GPU_LAYERS set them. */
	defaultGpuLayers?: number;
	/** Job Object host. Required on Windows so the engine cannot outlive the CLI. */
	hostPath?: string;
	logPath: string;
	/** Private directory for the short-lived API key file. Defaults to `<logPath>/../../run`. */
	keyDir?: string;
	signal?: AbortSignal;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ChatRequest {
	messages: ChatMessage[];
	maxTokens: number;
	temperature?: number;
	topP?: number;
	/** JSON schema for grammar-constrained output. */
	jsonSchema?: Record<string, unknown>;
	/** Passed to the chat template's `enable_thinking` switch. Omitted: template default (on). */
	enableThinking?: boolean;
	signal?: AbortSignal;
}

export interface ChatResult {
	content: string;
	reasoning?: string;
	finishReason: string;
	promptTokens: number;
	completionTokens: number;
	promptMs?: number;
	predictedMs?: number;
}

function positiveIntegerEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
	return value;
}

/** Offload every layer. llama.cpp caps this at the model's layer count. */
export const ALL_GPU_LAYERS = 999;

export const DEFAULT_CONTEXT_SIZE = 8192;

/**
 * Defaults tuned for a small interactive helper; see IMPLEMENTATION_PLAN.md section 7.
 * `defaultGpuLayers` comes from the selected backend; the environment still wins over it.
 */
export function resolveEngineSettings(overrides: Partial<EngineSettings> = {}, defaultGpuLayers = 0): EngineSettings {
	return {
		contextSize: overrides.contextSize ?? positiveIntegerEnv("MIDNIGHT_SERVER_CONTEXT") ?? DEFAULT_CONTEXT_SIZE,
		threads:
			overrides.threads ??
			positiveIntegerEnv("MIDNIGHT_SERVER_THREADS") ??
			Math.max(1, Math.min(8, availableParallelism() - 2)),
		gpuLayers: overrides.gpuLayers ?? positiveIntegerEnv("MIDNIGHT_SERVER_GPU_LAYERS") ?? defaultGpuLayers,
		startupTimeoutMs: overrides.startupTimeoutMs ?? 180_000,
	};
}

async function reservePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolvePort(port));
		});
	});
}

/**
 * Only what the engine needs. Provider credentials in the parent environment are
 * not inherited. GPU device selection variables are, and PATH follows the engine
 * directory so vendor runtimes (oneAPI, ROCm, OpenVINO) installed system-wide load.
 */
export function engineEnvironment(engineDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of [
		"SystemRoot",
		"windir",
		"SystemDrive",
		"TEMP",
		"TMP",
		"NUMBER_OF_PROCESSORS",
		"PROCESSOR_ARCHITECTURE",
		"PROCESSOR_IDENTIFIER",
		"LANG",
		"HOME",
		"XDG_RUNTIME_DIR",
		"LD_LIBRARY_PATH",
		"CUDA_VISIBLE_DEVICES",
		"HIP_VISIBLE_DEVICES",
		"ROCR_VISIBLE_DEVICES",
		"ONEAPI_DEVICE_SELECTOR",
	]) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	for (const [name, value] of Object.entries(process.env)) {
		if ((name.startsWith("GGML_") || name.startsWith("VK_")) && value !== undefined) env[name] = value;
	}
	const systemRoot = process.env.SystemRoot;
	env.PATH = [engineDir, ...(systemRoot ? [join(systemRoot, "System32")] : []), process.env.PATH ?? process.env.Path]
		.filter(Boolean)
		.join(delimiter);
	// The engine's shared libraries sit beside llama-server. macOS builds find them
	// through their rpath (DYLD_* would be stripped by /bin/sh under SIP anyway).
	if (process.platform === "linux") {
		env.LD_LIBRARY_PATH = [engineDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter);
	}
	return env;
}

/** Last lines of the engine log, so a startup failure (missing driver or library) is visible without opening it. */
function logTail(logPath: string, lines = 6): string {
	try {
		return readFileSync(logPath, "utf8").trimEnd().split(/\r?\n/).slice(-lines).join("\n");
	} catch {
		return "";
	}
}

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

/**
 * The Linux/macOS counterpart of midnight-host: `sh -c POSIX_HOST <name> <server> <args...>`.
 * Our stdin is the ownership pipe. It reaches EOF when the CLI closes it or dies,
 * even from SIGKILL, and the watcher then terminates the engine. SIGTERM to the
 * wrapper does the same. A non-interactive shell gives background jobs /dev/null
 * as stdin, so the pipe is passed to the watcher through fd 3.
 */
const POSIX_HOST = `exec 3<&0
"$@" </dev/null &
pid=$!
( while IFS= read -r _; do :; done <&3; kill "$pid" 2>/dev/null ) &
watcher=$!
exec 3<&-
trap 'kill "$pid" 2>/dev/null' TERM INT HUP
wait "$pid"
status=$?
wait "$pid" 2>/dev/null
kill "$watcher" 2>/dev/null
exit "$status"`;

/** Command line that runs the engine under an owner that stops it when the CLI exits. */
export function hostedCommand(serverExe: string, args: string[], hostPath: string | undefined): [string, string[]] {
	if (hostPath) return [hostPath, [serverExe, ...args]];
	return ["/bin/sh", ["-c", POSIX_HOST, "midnight-host", serverExe, ...args]];
}

/**
 * A llama-server process owned by this CLI, bound to loopback with a random
 * per-session key. It runs under a host whose lifetime is tied to our stdin pipe
 * (a Job Object on Windows, POSIX_HOST elsewhere), so the engine exits with the
 * CLI even after a crash.
 */
export class LocalEngine {
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly settings: EngineSettings;
	private readonly child: ChildProcess;
	private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	private stopped = false;
	private queue: Promise<unknown> = Promise.resolve();

	private constructor(child: ChildProcess, baseUrl: string, apiKey: string, settings: EngineSettings) {
		this.child = child;
		this.baseUrl = baseUrl;
		this.apiKey = apiKey;
		this.settings = settings;
		child.on("exit", (code, signal) => {
			this.exitInfo = { code, signal };
		});
	}

	static async start(options: EngineStartOptions): Promise<LocalEngine> {
		const settings = resolveEngineSettings(options, options.defaultGpuLayers);
		const serverExe = join(options.engineDir, process.platform === "win32" ? "llama-server.exe" : "llama-server");
		if (process.platform === "win32" && !options.hostPath) {
			throw new Error("midnight-host.exe was not found; refusing to start an engine without process ownership.");
		}
		mkdirSync(dirname(options.logPath), { recursive: true });
		// llama-server reads keys only from argv or a file. A file under the per-user
		// state directory keeps the key out of process listings; it is deleted once
		// the server has read it.
		const keyDir = options.keyDir ?? join(dirname(options.logPath), "..", "run");
		mkdirSync(keyDir, { recursive: true });

		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			const port = await reservePort();
			const apiKey = randomBytes(32).toString("hex");
			const keyName = `engine-${process.pid}-${randomBytes(6).toString("hex")}.key`;
			const keyFile = join(keyDir, keyName);
			writeFileSync(keyFile, `${apiKey}\n`, { mode: 0o600, flag: "wx" });
			const args = [
				// llama-server opens this file with the ANSI code page on Windows, so a
				// non-ASCII profile path would fail. Pass an ASCII name relative to cwd.
				"--api-key-file",
				keyName,
				"--model",
				options.modelPath,
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--no-webui",
				"--jinja",
				"--ctx-size",
				String(settings.contextSize),
				"--parallel",
				"1",
				"--n-gpu-layers",
				String(settings.gpuLayers),
				"--threads",
				String(settings.threads),
				// Prompt processing scales with every logical core; generation peaks below that
				// (measured on a 4-core/8-thread laptop CPU: docs/benchmarks/cpu-i7-8650u.md).
				"--threads-batch",
				String(Math.max(settings.threads, availableParallelism())),
			];
			const log = openSync(options.logPath, "a");
			const [command, commandArgs] = hostedCommand(serverExe, args, options.hostPath);
			const child = spawn(command, commandArgs, {
				cwd: keyDir,
				env: engineEnvironment(options.engineDir),
				// stdin is the ownership pipe for midnight-host; keep it open until stop().
				stdio: ["pipe", log, log],
				windowsHide: true,
			});
			closeSync(log);
			const engine = new LocalEngine(child, `http://127.0.0.1:${port}`, apiKey, settings);
			try {
				await engine.waitUntilReady(settings.startupTimeoutMs, options.signal, options.logPath);
				await engine.assertAuthenticated();
				return engine;
			} catch (error) {
				lastError = error;
				await engine.stop();
				if (options.signal?.aborted) throw error;
				// Only retry an early exit, which usually means the port was taken.
				if (!(error instanceof EngineExitedError)) break;
			} finally {
				rmSync(keyFile, { force: true });
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	get running(): boolean {
		return !this.stopped && this.exitInfo === undefined;
	}

	private async waitUntilReady(timeoutMs: number, signal: AbortSignal | undefined, logPath: string): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			signal?.throwIfAborted();
			if (this.exitInfo) {
				const tail = logTail(logPath);
				throw new EngineExitedError(
					`Engine exited during startup (code ${this.exitInfo.code}). Engine log ${logPath}${tail ? `:\n${tail}` : "."}`,
				);
			}
			if (await this.health()) return;
			await delay(250);
		}
		throw new Error(`Engine did not become ready within ${Math.round(timeoutMs / 1000)} s`);
	}

	/** Fail closed if the inference endpoint accepts requests without the session key. */
	private async assertAuthenticated(): Promise<void> {
		const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
			signal: AbortSignal.timeout(5000),
		});
		await response.body?.cancel();
		if (response.status !== 401) {
			throw new Error(`Engine accepted an unauthenticated request (HTTP ${response.status}); refusing to use it.`);
		}
	}

	async health(): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl}/health`, {
				headers: { Authorization: `Bearer ${this.apiKey}` },
				signal: AbortSignal.timeout(2000),
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	/**
	 * One non-streaming chat completion. Requests are serialized so a helper
	 * never competes with another helper for the single engine slot.
	 */
	chat(request: ChatRequest): Promise<ChatResult> {
		const next = this.queue.then(
			() => this.chatNow(request),
			() => this.chatNow(request),
		);
		this.queue = next.catch(() => {});
		return next;
	}

	private async chatNow(request: ChatRequest): Promise<ChatResult> {
		request.signal?.throwIfAborted();
		if (!this.running) throw new Error("Local engine is not running");
		const body: Record<string, unknown> = {
			model: "local",
			messages: request.messages,
			max_tokens: request.maxTokens,
			temperature: request.temperature ?? 1.0,
			top_p: request.topP ?? 0.95,
			min_p: 0,
			stream: false,
		};
		if (request.enableThinking !== undefined) {
			body.chat_template_kwargs = { enable_thinking: request.enableThinking };
		}
		if (request.jsonSchema) {
			body.response_format = { type: "json_schema", json_schema: { name: "result", schema: request.jsonSchema } };
		}
		const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: request.signal,
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`Local engine HTTP ${response.status}: ${text.slice(0, 500)}`);
		const payload = JSON.parse(text) as {
			choices?: Array<{ message?: { content?: string | null; reasoning_content?: string }; finish_reason?: string }>;
			usage?: { prompt_tokens?: number; completion_tokens?: number };
			timings?: { prompt_ms?: number; predicted_ms?: number };
		};
		const choice = payload.choices?.[0];
		return {
			content: choice?.message?.content ?? "",
			reasoning: choice?.message?.reasoning_content,
			finishReason: choice?.finish_reason ?? "unknown",
			promptTokens: payload.usage?.prompt_tokens ?? 0,
			completionTokens: payload.usage?.completion_tokens ?? 0,
			promptMs: payload.timings?.prompt_ms,
			predictedMs: payload.timings?.predicted_ms,
		};
	}

	/** Close the ownership pipe, then force-terminate if the process lingers. Idempotent. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.exitInfo) return;
		const exited = new Promise<void>((resolveExit) => this.child.once("exit", () => resolveExit()));
		this.child.stdin?.end();
		const timedOut = await Promise.race([exited.then(() => false), delay(5000).then(() => true)]);
		if (timedOut) {
			this.child.kill();
			await Promise.race([exited, delay(2000)]);
		}
	}

	/** Synchronous best-effort cleanup for process exit handlers. */
	stopSync(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.child.stdin?.destroy();
	}
}

export class EngineExitedError extends Error {}
