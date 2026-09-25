import { join } from "node:path";
import type { DownloadProgress } from "./download.ts";
import { type EngineSettings, LocalEngine } from "./engine.ts";
import type { ModelLock } from "./model-integrity.ts";
import { getLogDir, getMidnightHome } from "./paths.ts";
import { ENGINE_LOCK, type EngineLock, MODEL_LOCK } from "./pins.ts";
import { ensureModelVerified, fetchEngine, fetchModel, findEngineDir, findHost, findModel } from "./store.ts";

export class LocalSetupError extends Error {}

export interface ResolvedLocalAssets {
	modelPath: string;
	engineDir: string;
	hostPath?: string;
}

const GiB = 1024 ** 3;

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

/**
 * Locate the pinned model, engine and host, downloading the model and (on the
 * one supported platform) the engine automatically the first time either is
 * missing, so a fresh install works without a separate setup step. An explicit
 * `MIDNIGHT_SERVER_MODEL` / `MIDNIGHT_SERVER_ENGINE_DIR` override is never
 * routed around: if it points at nothing, that is a configuration error, not
 * something to silently download past.
 */
export async function resolveLocalAssets(
	signal?: AbortSignal,
	onStatus?: (message: string) => void,
	locks: { model?: ModelLock; engine?: EngineLock } = {},
): Promise<ResolvedLocalAssets> {
	const modelLock = locks.model ?? MODEL_LOCK;
	const engineLock = locks.engine ?? ENGINE_LOCK;

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
				`Could not download the local model automatically: ${error instanceof Error ? error.message : String(error)}. Run: midnight.server model fetch`,
			);
		}
	}

	let engineDir = findEngineDir(engineLock);
	if (!engineDir) {
		if (process.env.MIDNIGHT_SERVER_ENGINE_DIR) {
			throw new LocalSetupError(
				`MIDNIGHT_SERVER_ENGINE_DIR is set to ${process.env.MIDNIGHT_SERVER_ENGINE_DIR}, but it is not a complete llama.cpp build.`,
			);
		}
		if (process.platform !== "win32" || process.arch !== "x64") {
			throw new LocalSetupError(
				"The local inference engine is not installed for this platform. Set MIDNIGHT_SERVER_ENGINE_DIR to a llama.cpp build.",
			);
		}
		onStatus?.("Downloading the local inference engine (one-time)...");
		try {
			engineDir = await fetchEngine(engineLock, { signal, onProgress: reportProgress(onStatus, "Engine download") });
		} catch (error) {
			throw new LocalSetupError(
				`Could not download the local inference engine automatically: ${error instanceof Error ? error.message : String(error)}. Run: midnight.server engine fetch`,
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
			`Model verification failed for ${modelPath}: ${error instanceof Error ? error.message : String(error)}. Delete it and run: midnight.server model fetch`,
		);
	}
	return { modelPath, engineDir, hostPath };
}

/**
 * Owns at most one engine for this process. Starts it on first use, shares the
 * in-flight start between concurrent callers, and stops it after an idle period
 * or on shutdown.
 */
export class EngineManager {
	private engine: LocalEngine | undefined;
	private starting: Promise<LocalEngine> | undefined;
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

	async get(signal?: AbortSignal): Promise<LocalEngine> {
		this.touch();
		if (this.engine?.running) return this.engine;
		if (!this.starting) {
			this.starting = (async () => {
				this.onStatus?.("Preparing local model...");
				const assets = await resolveLocalAssets(signal, this.onStatus);
				this.onStatus?.("Starting local engine...");
				const engine = await LocalEngine.start({
					...assets,
					...this.settings,
					logPath: join(getLogDir(), "engine.log"),
					keyDir: join(getMidnightHome(), "run"),
					signal,
				});
				this.engine = engine;
				return engine;
			})().finally(() => {
				this.starting = undefined;
			});
		}
		return this.starting;
	}

	/** Keep the engine alive while in use; stop it after `idleMs` without requests. */
	touch(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.idleMs > 0) {
			this.idleTimer = setTimeout(() => void this.stop(), this.idleMs);
			this.idleTimer.unref();
		}
	}

	async stop(): Promise<void> {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		const engine = this.engine ?? (await this.starting?.catch(() => undefined));
		this.engine = undefined;
		await engine?.stop();
	}

	stopSync(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.engine?.stopSync();
		this.engine = undefined;
	}
}
