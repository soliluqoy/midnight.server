import { join } from "node:path";
import { type EngineSettings, LocalEngine } from "./engine.ts";
import { getLogDir, getMidnightHome } from "./paths.ts";
import { MODEL_LOCK } from "./pins.ts";
import { ensureModelVerified, findEngineDir, findHost, findModel } from "./store.ts";

export class LocalSetupError extends Error {}

export interface ResolvedLocalAssets {
	modelPath: string;
	engineDir: string;
	hostPath?: string;
}

/** Locate and verify the pinned model, engine and host. Throws actionable setup errors. */
export async function resolveLocalAssets(signal?: AbortSignal): Promise<ResolvedLocalAssets> {
	const modelPath = findModel();
	if (!modelPath) {
		throw new LocalSetupError(
			`The MiniCPM model (${MODEL_LOCK.fileName}) is not installed. Run: midnight.server model fetch`,
		);
	}
	const engineDir = findEngineDir();
	if (!engineDir) {
		throw new LocalSetupError("The local inference engine is not installed. Run: midnight.server engine fetch");
	}
	const hostPath = findHost();
	if (process.platform === "win32" && !hostPath) {
		throw new LocalSetupError(
			"midnight-host.exe is missing from this installation; the engine cannot be started with process ownership. Reinstall, or build it with scripts\\build.ps1.",
		);
	}
	try {
		await ensureModelVerified(modelPath, MODEL_LOCK, { signal });
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
				this.onStatus?.("Verifying local model...");
				const assets = await resolveLocalAssets(signal);
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
