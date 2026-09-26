import { join } from "node:path";
import {
	type BackendChoice,
	listDevices,
	newChoice,
	type ProbeResult,
	probeBackends,
	readBackendChoice,
	requestedBackend,
	userGpuLayers,
	writeBackendChoice,
} from "./backend.ts";
import type { DownloadProgress } from "./download.ts";
import { ALL_GPU_LAYERS, type EngineSettings, engineEnvironment, LocalEngine } from "./engine.ts";
import type { ModelLock } from "./model-integrity.ts";
import { getLogDir, getMidnightHome } from "./paths.ts";
import { cpuBackend, type EngineLock, engineDownloadBytes, engineLock, MODEL_LOCK } from "./pins.ts";
import { updateMidnightStatus } from "./status.ts";
import {
	ensureModelVerified,
	fetchEngine,
	fetchModel,
	findEngineDir,
	findHost,
	findModel,
	installedEngineDir,
} from "./store.ts";

export class LocalSetupError extends Error {}

/** The user stopped the local model for this session with /local-stop. */
export class LocalStoppedError extends Error {
	constructor() {
		super("The local model was stopped for this session with /local-stop. Run /local-start to use it again.");
	}
}

export interface ResolvedModel {
	modelPath: string;
	hostPath?: string;
}

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** Turns download byte counts into occasional, human-readable status lines instead of one per chunk. */
function reportProgress(
	onStatus: ((message: string) => void) | undefined,
	label: string,
): ((progress: DownloadProgress) => void) | undefined {
	if (!onStatus) return undefined;
	let lastPercent = -1;
	return ({ receivedBytes, totalBytes }) => {
		const percent = Math.floor((receivedBytes / totalBytes) * 100);
		if (percent === lastPercent) return;
		lastPercent = percent;
		onStatus(`${label}: ${percent}% (${(receivedBytes / GiB).toFixed(2)} / ${(totalBytes / GiB).toFixed(2)} GiB)`);
	};
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Locate and verify the pinned model and the process host, downloading the
 * model the first time it is missing. An explicit `MIDNIGHT_SERVER_MODEL`
 * override is never routed around: if it points at nothing, that is a
 * configuration error, not something to silently download past.
 */
export async function resolveModel(
	signal?: AbortSignal,
	onStatus?: (message: string) => void,
	modelLock: ModelLock = MODEL_LOCK,
): Promise<ResolvedModel> {
	let modelPath = findModel(modelLock);
	if (!modelPath) {
		if (process.env.MIDNIGHT_SERVER_MODEL) {
			throw new LocalSetupError(
				`MIDNIGHT_SERVER_MODEL is set to ${process.env.MIDNIGHT_SERVER_MODEL}, but no file exists there.`,
			);
		}
		onStatus?.(
			`Downloading the local model (${modelLock.fileName}, ${(modelLock.sizeBytes / GiB).toFixed(2)} GiB, one-time)...`,
		);
		try {
			modelPath = await fetchModel(modelLock, { signal, onProgress: reportProgress(onStatus, "Model download") });
		} catch (error) {
			throw new LocalSetupError(
				`Could not download the local model automatically: ${errorText(error)}. Run: midnight.server model fetch`,
			);
		}
	}

	const hostPath = findHost();
	if (process.platform === "win32" && !hostPath) {
		throw new LocalSetupError(
			"midnight-host.exe is missing from this installation; the engine cannot be started with process ownership. Reinstall, or build it with scripts\\build.ps1.",
		);
	}
	try {
		await ensureModelVerified(modelPath, modelLock, { signal });
	} catch (error) {
		throw new LocalSetupError(
			`Model verification failed for ${modelPath}: ${errorText(error)}. Delete it and run: midnight.server model fetch`,
		);
	}
	return { modelPath, hostPath };
}

/**
 * The llama-server directory for a pinned build, downloading it the first time.
 * `MIDNIGHT_SERVER_ENGINE_DIR` wins over `lock` and fails closed if it is not a
 * llama.cpp build.
 */
export async function resolveEngine(
	lock: EngineLock | undefined,
	signal?: AbortSignal,
	onStatus?: (message: string) => void,
): Promise<string> {
	const found = findEngineDir(lock);
	if (found) return found;
	if (process.env.MIDNIGHT_SERVER_ENGINE_DIR) {
		throw new LocalSetupError(
			`MIDNIGHT_SERVER_ENGINE_DIR is set to ${process.env.MIDNIGHT_SERVER_ENGINE_DIR}, but it does not contain llama-server.`,
		);
	}
	if (!lock) {
		throw new LocalSetupError(
			`No pinned inference engine for ${process.platform}-${process.arch}. Set MIDNIGHT_SERVER_ENGINE_DIR to a llama.cpp build.`,
		);
	}
	onStatus?.(
		`Downloading the ${lock.backend} inference engine (${Math.round(engineDownloadBytes(lock) / MiB)} MiB, one-time)...`,
	);
	try {
		const root = await fetchEngine(lock, { signal, onProgress: reportProgress(onStatus, "Engine download") });
		const dir = installedEngineDir(root, lock);
		if (!dir) throw new Error(`the installed engine at ${root} is incomplete`);
		return dir;
	} catch (error) {
		throw new LocalSetupError(
			`Could not download the ${lock.backend} inference engine automatically: ${errorText(error)}. Run: midnight.server engine fetch ${lock.backend}`,
		);
	}
}

export interface EngineContext {
	model: ResolvedModel;
	settings?: Partial<EngineSettings>;
	signal?: AbortSignal;
	onStatus?: (message: string) => void;
}

function startEngine(context: EngineContext, engineDir: string, defaultGpuLayers: number, settings = context.settings) {
	return LocalEngine.start({
		...context.model,
		engineDir,
		defaultGpuLayers,
		...settings,
		logPath: join(getLogDir(), "engine.log"),
		keyDir: join(getMidnightHome(), "run"),
		signal: context.signal,
	});
}

/** Measure the candidate backends on this machine now. Does not save the result. */
export function probe(context: EngineContext): Promise<ProbeResult> {
	return probeBackends({
		ensureEngine: (lock) => resolveEngine(lock, context.signal, context.onStatus),
		// A short context loads faster; the measured request fits in it.
		startEngine: (engineDir, gpuLayers) => startEngine(context, engineDir, gpuLayers, { contextSize: 4096 }),
		listDevices: (engineDir) => listDevices(engineDir, engineEnvironment(engineDir)),
		modelBytes: MODEL_LOCK.sizeBytes,
		onStatus: context.onStatus,
	});
}

export interface SelectedBackend {
	lock: EngineLock;
	gpuLayers: number;
	/** Automatic choices fall back to the CPU when the chosen engine fails to start. */
	auto: boolean;
}

/**
 * Backend precedence: `MIDNIGHT_SERVER_BACKEND`, then the saved choice (from
 * `engine use` or an earlier measurement), then a new measurement, saved.
 */
export async function selectBackend(context: EngineContext): Promise<SelectedBackend> {
	let requested: ReturnType<typeof requestedBackend>;
	try {
		requested = requestedBackend();
	} catch (error) {
		throw new LocalSetupError(errorText(error));
	}
	if (requested !== "auto") {
		const lock = engineLock(requested);
		if (!lock) throw new LocalSetupError(`No pinned ${requested} engine for this platform`);
		return { lock, gpuLayers: userGpuLayers(requested), auto: false };
	}
	const saved = await readBackendChoice();
	const savedLock = saved && engineLock(saved.backend);
	if (saved && savedLock) return { lock: savedLock, gpuLayers: saved.gpuLayers, auto: saved.source === "auto" };

	const result = await probe(context);
	if (result.persist) await writeBackendChoice(result.choice);
	context.onStatus?.(`Engine: ${describeChoice(result.choice)}`);
	const lock = engineLock(result.choice.backend);
	if (!lock) throw new LocalSetupError(`No pinned ${result.choice.backend} engine for this platform`);
	return { lock, gpuLayers: result.choice.gpuLayers, auto: true };
}

export interface SelectionPreview {
	lock: EngineLock | undefined;
	gpuLayers: number;
	label: string;
}

/** What `selectBackend` would use, without measuring or downloading anything. */
export async function previewSelection(): Promise<SelectionPreview> {
	if (process.env.MIDNIGHT_SERVER_ENGINE_DIR) {
		return { lock: undefined, gpuLayers: ALL_GPU_LAYERS, label: "MIDNIGHT_SERVER_ENGINE_DIR (your own build)" };
	}
	const requested = requestedBackend();
	if (requested !== "auto") {
		return {
			lock: engineLock(requested),
			gpuLayers: userGpuLayers(requested),
			label: `${requested} (MIDNIGHT_SERVER_BACKEND)`,
		};
	}
	const saved = await readBackendChoice();
	if (saved) return { lock: engineLock(saved.backend), gpuLayers: saved.gpuLayers, label: describeChoice(saved) };
	return {
		lock: engineLock(cpuBackend()),
		gpuLayers: 0,
		label: "auto (GPU and CPU are measured on first start)",
	};
}

export function describeChoice(choice: BackendChoice): string {
	const where = choice.gpuLayers > 0 ? "GPU" : "CPU";
	return `${choice.backend} on ${where} (${choice.source === "user" ? "set by user" : choice.reason})`;
}

/**
 * Start the engine with the selected backend. An automatic GPU choice that no
 * longer starts (driver removed, GPU gone) falls back to the CPU and is
 * replaced by a CPU choice, so later sessions do not retry it.
 */
export async function startSelectedEngine(context: EngineContext): Promise<LocalEngine> {
	if (process.env.MIDNIGHT_SERVER_ENGINE_DIR) {
		// The user's own build: offload everything; a CPU-only build ignores it.
		return startEngine(context, await resolveEngine(undefined), ALL_GPU_LAYERS);
	}
	const selected = await selectBackend(context);
	const engineDir = await resolveEngine(selected.lock, context.signal, context.onStatus);
	context.onStatus?.("Starting local engine...");
	try {
		return await startEngine(context, engineDir, selected.gpuLayers);
	} catch (error) {
		const cpuLock = engineLock(cpuBackend());
		const alreadyCpu = selected.lock.backend === cpuLock?.backend && selected.gpuLayers === 0;
		if (!selected.auto || alreadyCpu || !cpuLock || context.signal?.aborted) throw error;
		const reason = `the ${selected.lock.backend} engine failed to start: ${errorText(error).split("\n")[0]}`;
		context.onStatus?.(`${reason}. Using the CPU instead.`);
		await writeBackendChoice(newChoice(cpuLock, 0, "auto", reason));
		return startEngine(context, await resolveEngine(cpuLock, context.signal, context.onStatus), 0);
	}
}

/**
 * Owns at most one engine for this process. Starts it on first use, shares the
 * in-flight start between concurrent callers, and stops it after an idle period
 * or on shutdown. `disable()` stops it for the rest of the session: every later
 * `get()` fails until `enable()`.
 */
export class EngineManager {
	private engine: LocalEngine | undefined;
	private starting: Promise<LocalEngine> | undefined;
	private disabled = false;
	/** Aborts an in-flight start (including downloads) when the engine is disabled. */
	private startAbort = new AbortController();
	private idleTimer: NodeJS.Timeout | undefined;
	private readonly idleMs: number;
	private readonly settings: Partial<EngineSettings>;
	private readonly onStatus?: (message: string) => void;

	constructor(
		options: { idleMs?: number; settings?: Partial<EngineSettings>; onStatus?: (message: string) => void } = {},
	) {
		this.idleMs = options.idleMs ?? Number(process.env.MIDNIGHT_SERVER_IDLE_MS ?? 15 * 60_000);
		this.settings = options.settings ?? {};
		this.onStatus = options.onStatus;
	}

	get current(): LocalEngine | undefined {
		return this.engine?.running ? this.engine : undefined;
	}

	/** True after `disable()` until `enable()`. */
	get isDisabled(): boolean {
		return this.disabled;
	}

	async get(callerSignal?: AbortSignal): Promise<LocalEngine> {
		if (this.disabled) throw new LocalStoppedError();
		this.touch();
		if (this.engine?.running) return this.engine;
		if (!this.starting) {
			updateMidnightStatus({ engine: "starting" });
			const signal = callerSignal ? AbortSignal.any([callerSignal, this.startAbort.signal]) : this.startAbort.signal;
			this.starting = (async () => {
				this.onStatus?.("Preparing local model...");
				const model = await resolveModel(signal, this.onStatus);
				const engine = await startSelectedEngine({
					model,
					settings: this.settings,
					signal,
					onStatus: this.onStatus,
				});
				this.engine = engine;
				updateMidnightStatus({ engine: "ready", activity: undefined });
				return engine;
			})()
				.catch((error: unknown) => {
					if (this.disabled) throw new LocalStoppedError();
					updateMidnightStatus({
						engine: error instanceof LocalSetupError ? "unavailable" : "off",
						activity: undefined,
					});
					throw error;
				})
				.finally(() => {
					this.starting = undefined;
				});
		}
		return this.starting;
	}

	/** Keep the engine alive while in use; stop it after `idleMs` without requests. */
	touch(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.idleMs > 0 && !this.disabled) {
			this.idleTimer = setTimeout(() => void this.stop(), this.idleMs);
			this.idleTimer.unref();
		}
	}

	async stop(): Promise<void> {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		const engine = this.engine ?? (await this.starting?.catch(() => undefined));
		this.engine = undefined;
		await engine?.stop();
		if (engine) updateMidnightStatus({ engine: "off" });
	}

	/**
	 * Stop the engine for the rest of the session: cancel a start or download in
	 * progress, kill the running engine (failing its in-flight requests), and make
	 * every later `get()` throw `LocalStoppedError` until `enable()`.
	 */
	async disable(): Promise<void> {
		this.disabled = true;
		this.startAbort.abort(new LocalStoppedError());
		await this.stop();
		updateMidnightStatus({ engine: "stopped", activity: undefined });
	}

	/** Allow the engine to start again on next use. */
	enable(): void {
		if (!this.disabled) return;
		this.disabled = false;
		this.startAbort = new AbortController();
		updateMidnightStatus({ engine: "off" });
	}

	stopSync(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.engine) updateMidnightStatus({ engine: "off" });
		this.engine?.stopSync();
		this.engine = undefined;
	}
}
