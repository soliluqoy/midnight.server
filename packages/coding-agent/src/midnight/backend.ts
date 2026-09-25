import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ALL_GPU_LAYERS, type ChatResult, type LocalEngine } from "./engine.ts";
import { backendChoicePath } from "./paths.ts";
import {
	availableBackends,
	cpuBackend,
	currentEnginePlatform,
	type EngineBackend,
	type EngineLock,
	type EnginePlatform,
	engineLock,
	parseBackend,
} from "./pins.ts";
import { serverFileName } from "./store.ts";

const MiB = 1024 ** 2;

export interface GpuDevice {
	/** llama.cpp device id, e.g. `Vulkan0`, `CUDA0`, `MTL0`. */
	id: string;
	name: string;
	totalMiB: number;
	freeMiB: number;
}

/** Parse `llama-server --list-devices`: `  Vulkan0: Intel(R) UHD Graphics 620 (8129 MiB, 7467 MiB free)`. */
export function parseDevices(output: string): GpuDevice[] {
	const devices: GpuDevice[] = [];
	for (const line of output.split(/\r?\n/)) {
		const match = /^\s+([A-Za-z][\w-]*?\d+): (.+) \((\d+) MiB, (\d+) MiB free\)\s*$/.exec(line);
		if (match) devices.push({ id: match[1], name: match[2], totalMiB: Number(match[3]), freeMiB: Number(match[4]) });
	}
	return devices;
}

export function listDevices(engineDir: string, env: NodeJS.ProcessEnv): Promise<GpuDevice[]> {
	return new Promise((resolveDevices) => {
		execFile(
			join(engineDir, serverFileName()),
			["--list-devices"],
			{ env, cwd: engineDir, timeout: 30_000, windowsHide: true, maxBuffer: MiB },
			// A missing GPU driver or loader makes the backend report no devices, or the process fail: both mean none.
			(_error, stdout, stderr) => resolveDevices(parseDevices(`${stdout}\n${stderr}`)),
		);
	});
}

/**
 * A typical helper task: a few files of context in, a short answer out. Prompt
 * processing and generation speeds trade off differently per device (an
 * integrated GPU can be faster at the first and slower at the second), so the
 * choice compares estimated time for this workload rather than one number.
 */
export const TYPICAL_TASK = { promptTokens: 2000, generatedTokens: 300 };

export interface BackendMeasurement {
	backend: EngineBackend;
	gpuLayers: number;
	promptTokensPerSecond: number;
	generationTokensPerSecond: number;
	/** Seconds for TYPICAL_TASK at the measured speeds. */
	estimatedSeconds: number;
}

type BenchEngine = Pick<LocalEngine, "chat" | "stop">;

const BENCH_PROMPT = [
	"Read these build notes, then list every note number from 1 to 40, separated by commas.",
	...Array.from(
		{ length: 40 },
		(_, index) =>
			`Note ${index + 1}: the build step writes its output directory, records a checksum, and reports the elapsed time.`,
	),
].join("\n");

export async function measureEngine(
	backend: EngineBackend,
	gpuLayers: number,
	start: () => Promise<BenchEngine>,
): Promise<BackendMeasurement> {
	const engine = await start();
	try {
		// The first request compiles GPU kernels on some backends; keep it out of the measurement.
		await engine.chat({ messages: [{ role: "user", content: "Say hi." }], maxTokens: 4, enableThinking: false });
		const reply: ChatResult = await engine.chat({
			messages: [{ role: "user", content: BENCH_PROMPT }],
			maxTokens: 64,
			temperature: 0,
			enableThinking: false,
		});
		if (reply.completionTokens < 8 || !reply.promptMs || !reply.predictedMs) {
			throw new Error(`the model produced no usable output (${reply.completionTokens} tokens)`);
		}
		const promptTokensPerSecond = reply.promptTokens / (reply.promptMs / 1000);
		const generationTokensPerSecond = reply.completionTokens / (reply.predictedMs / 1000);
		return {
			backend,
			gpuLayers,
			promptTokensPerSecond,
			generationTokensPerSecond,
			estimatedSeconds:
				TYPICAL_TASK.promptTokens / promptTokensPerSecond +
				TYPICAL_TASK.generatedTokens / generationTokensPerSecond,
		};
	} finally {
		await engine.stop();
	}
}

export interface BackendChoice {
	release: string;
	platform: EnginePlatform;
	backend: EngineBackend;
	gpuLayers: number;
	/** `auto`: measured, falls back to CPU if it stops working. `user`: set with `engine use`, never overridden. */
	source: "auto" | "user";
	reason: string;
	measurements?: BackendMeasurement[];
	decidedAt: string;
}

/** The saved choice, if it still refers to a pinned build for this platform and engine release. */
export async function readBackendChoice(lock = engineLock(cpuBackend())): Promise<BackendChoice | undefined> {
	try {
		const choice = JSON.parse(await readFile(backendChoicePath(), "utf8")) as BackendChoice;
		const valid =
			choice.release === lock?.release &&
			choice.platform === currentEnginePlatform() &&
			availableBackends().includes(choice.backend);
		return valid ? choice : undefined;
	} catch {
		return undefined;
	}
}

export async function writeBackendChoice(choice: BackendChoice): Promise<void> {
	const path = backendChoicePath();
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(choice, null, "\t")}\n`);
	await rename(temp, path);
}

export async function clearBackendChoice(): Promise<void> {
	await rm(backendChoicePath(), { force: true });
}

export function newChoice(
	lock: EngineLock,
	gpuLayers: number,
	source: BackendChoice["source"],
	reason: string,
	measurements?: BackendMeasurement[],
): BackendChoice {
	return {
		release: lock.release,
		platform: lock.platform,
		backend: lock.backend,
		gpuLayers,
		source,
		reason,
		measurements,
		decidedAt: new Date().toISOString(),
	};
}

/** GPU layers for a backend the user picked by name: everything, except the plain CPU build. */
export function userGpuLayers(backend: EngineBackend): number {
	return backend === "cpu" ? 0 : ALL_GPU_LAYERS;
}

/** The GPU backend tried automatically. Others (CUDA, ROCm, SYCL, ...) are large or need vendor runtimes: opt-in. */
export function autoGpuBackend(platform = currentEnginePlatform()): EngineBackend | undefined {
	if (platform === "darwin-arm64") return "metal";
	return availableBackends(platform).includes("vulkan") ? "vulkan" : undefined;
}

export interface ProbeHooks {
	/** Find or download a pinned build; returns the llama-server directory. */
	ensureEngine(lock: EngineLock): Promise<string>;
	startEngine(engineDir: string, gpuLayers: number): Promise<BenchEngine>;
	listDevices(engineDir: string): Promise<GpuDevice[]>;
	modelBytes: number;
	onStatus?: (message: string) => void;
}

export interface ProbeResult {
	choice: BackendChoice;
	/** False when the result reflects a transient problem (a failed download) and should not be remembered. */
	persist: boolean;
}

/** GPU must be this much faster before it is preferred over the simpler CPU path. */
const GPU_ADVANTAGE = 0.9;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0];

/**
 * Pick the fastest engine that runs the model on this machine: find a GPU with
 * the automatic GPU backend, then run the model on it and on the CPU and keep
 * whichever finishes a typical task sooner. A backend that fails to start or to
 * generate is never chosen.
 */
export async function probeBackends(hooks: ProbeHooks, platform = currentEnginePlatform()): Promise<ProbeResult> {
	const cpuLock = engineLock(cpuBackend(platform), platform);
	if (!cpuLock) throw new Error(`No pinned engine for ${process.platform}-${process.arch}`);
	const cpu = (reason: string, measurements?: BackendMeasurement[], persist = true): ProbeResult => ({
		choice: newChoice(cpuLock, 0, "auto", reason, measurements),
		persist,
	});

	const gpuBackend = autoGpuBackend(platform);
	const gpuLock = gpuBackend ? engineLock(gpuBackend, platform) : undefined;
	if (!gpuLock) return cpu(`no automatic GPU backend for ${platform}`);

	hooks.onStatus?.("Checking for a GPU (one-time)...");
	let gpuDir: string;
	try {
		gpuDir = await hooks.ensureEngine(gpuLock);
	} catch (error) {
		return cpu(`could not get the ${gpuLock.backend} engine: ${errorText(error)}`, undefined, false);
	}
	const devices = await hooks.listDevices(gpuDir);
	if (devices.length === 0) return cpu(`${gpuLock.backend} found no GPU`);
	const needMiB = Math.ceil(hooks.modelBytes / MiB) + 512;
	const usable = devices.filter((device) => device.totalMiB >= needMiB);
	if (usable.length === 0) {
		return cpu(`GPU memory below ${needMiB} MiB: ${devices.map((device) => device.name).join(", ")}`);
	}
	const names = usable.map((device) => device.name).join(", ");

	hooks.onStatus?.(`Found ${names}. Measuring GPU and CPU speed with the local model (one-time)...`);
	let gpu: BackendMeasurement;
	try {
		gpu = await measureEngine(gpuLock.backend, ALL_GPU_LAYERS, () => hooks.startEngine(gpuDir, ALL_GPU_LAYERS));
	} catch (error) {
		return cpu(`the ${gpuLock.backend} engine failed on ${names}: ${errorText(error)}`);
	}
	let cpuResult: BackendMeasurement;
	try {
		const cpuDir = await hooks.ensureEngine(cpuLock);
		cpuResult = await measureEngine(cpuLock.backend, 0, () => hooks.startEngine(cpuDir, 0));
	} catch (error) {
		return {
			choice: newChoice(gpuLock, ALL_GPU_LAYERS, "auto", `CPU measurement failed (${errorText(error)})`, [gpu]),
			persist: true,
		};
	}
	const measurements = [gpu, cpuResult];
	const summary = `${Math.round(gpu.estimatedSeconds)} s on ${names} vs ${Math.round(cpuResult.estimatedSeconds)} s on CPU per typical task`;
	return gpu.estimatedSeconds < cpuResult.estimatedSeconds * GPU_ADVANTAGE
		? { choice: newChoice(gpuLock, ALL_GPU_LAYERS, "auto", summary, measurements), persist: true }
		: cpu(summary, measurements);
}

/** `MIDNIGHT_SERVER_BACKEND`: unset or `auto` selects automatically; otherwise a backend name for this platform. */
export function requestedBackend(): EngineBackend | "auto" {
	const raw = process.env.MIDNIGHT_SERVER_BACKEND?.trim().toLowerCase();
	if (!raw || raw === "auto") return "auto";
	const backend = parseBackend(raw);
	if (!backend) {
		const available = availableBackends();
		throw new Error(
			`MIDNIGHT_SERVER_BACKEND=${raw} is not available for ${process.platform}-${process.arch}. Available: auto, ${available.join(", ") || "none"}`,
		);
	}
	return backend;
}
