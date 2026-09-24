import type { InlineExtension } from "../core/extensions/types.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { createDriftWatchExtension, resolveDriftWatchSettings } from "./drift-watch.ts";
import { EngineManager, LocalSetupError } from "./engine-manager.ts";
import { createDelegateExtension, createLocalProviderExtension } from "./extension.ts";
import { LOCAL_MODEL_ID, LOCAL_PROVIDER_ID } from "./pins.ts";

export class LocalInferenceUnavailableError extends Error {}

export type MidnightMode = "default" | "local" | "hybrid";

export interface LocalRuntime {
	mode: MidnightMode;
	args: string[];
	extensionFactories: InlineExtension[];
	stop(): Promise<void>;
}

/** Flags that would pick a model other than the local one. */
const MODEL_SELECTION_FLAGS = ["--provider", "--model", "--models", "--api-key"];

export function parseMidnightMode(args: string[]): { mode: MidnightMode; rest: string[] } {
	const local = args.includes("--local");
	const hybrid = args.includes("--hybrid");
	if (local && hybrid) throw new LocalInferenceUnavailableError("--local and --hybrid cannot be combined.");
	const rest = args.filter((arg) => arg !== "--local" && arg !== "--hybrid");
	return { mode: local ? "local" : hybrid ? "hybrid" : "default", rest };
}

function hybridExtensions(manager: EngineManager): InlineExtension[] {
	return [
		{ name: "midnight-delegate", factory: createDelegateExtension(manager), hidden: true },
		{
			name: "midnight-drift-watch",
			factory: createDriftWatchExtension(manager, resolveDriftWatchSettings()),
			hidden: true,
		},
	];
}

/**
 * Local:           start the engine now, select the local model, force offline startup,
 *                  and block model requests to every other provider for the session.
 * Default/Hybrid:  keep the configured provider as the parent; add `delegate_local` and
 *                  the drift watcher, which start the engine on first use. If no provider
 *                  is configured at all (no explicit --provider/--model/--models/--api-key
 *                  either), silently drive the session on the local model instead —
 *                  switchable, not offline, so a later /login still works.
 */
export async function prepareLocalRuntime(
	args: string[],
	options: { manager?: EngineManager; onStatus?: (message: string) => void; modelRuntime?: ModelRuntime } = {},
): Promise<LocalRuntime> {
	const { mode, rest } = parseMidnightMode(args);

	if (mode === "local") {
		const conflict = rest.find((arg) => MODEL_SELECTION_FLAGS.includes(arg));
		if (conflict) {
			throw new LocalInferenceUnavailableError(
				`${conflict} cannot be used with --local; local mode always uses the embedded model.`,
			);
		}
		// Local mode keeps the engine for the whole session: the provider URL is fixed.
		const manager = options.manager ?? new EngineManager({ idleMs: 0, onStatus: options.onStatus });
		let engine: Awaited<ReturnType<EngineManager["get"]>>;
		try {
			engine = await manager.get();
		} catch (error) {
			if (error instanceof LocalSetupError) throw new LocalInferenceUnavailableError(error.message);
			throw error;
		}
		return {
			mode,
			args: [
				"--offline",
				"--provider",
				LOCAL_PROVIDER_ID,
				"--model",
				LOCAL_MODEL_ID,
				"--models",
				`${LOCAL_PROVIDER_ID}/${LOCAL_MODEL_ID}`,
				...rest,
			],
			extensionFactories: [
				{
					name: "midnight-local",
					factory: createLocalProviderExtension(engine, { localOnly: true }),
					hidden: true,
				},
			],
			stop: () => manager.stop(),
		};
	}

	// mode is "default" or "hybrid": try a silent, switchable local fallback only when the
	// caller made no explicit provider/model choice and nothing else is configured.
	const explicitChoice = rest.some((arg) => MODEL_SELECTION_FLAGS.includes(arg));
	let fallbackToLocal = false;
	if (!explicitChoice) {
		const modelRuntime =
			options.modelRuntime ??
			(await ModelRuntime.create({ allowModelNetwork: false, signal: AbortSignal.timeout(5_000) }));
		fallbackToLocal = modelRuntime.getAvailableSnapshot().length === 0;
	}

	if (fallbackToLocal) {
		// Keep the engine for the whole session, same as --local, since it's the parent here too.
		const manager = options.manager ?? new EngineManager({ idleMs: 0, onStatus: options.onStatus });
		let engine: Awaited<ReturnType<EngineManager["get"]>>;
		try {
			engine = await manager.get();
		} catch (error) {
			if (!(error instanceof LocalSetupError)) throw error;
			// This fallback is implicit; nobody asked for --local, so don't hard-fail the CLI
			// the way an explicit --local does. Fall through to ordinary hybrid behavior and
			// let main()'s usual "no provider configured" onboarding handle it.
			return { mode, args: rest, extensionFactories: hybridExtensions(manager), stop: () => manager.stop() };
		}
		return {
			mode,
			args: [
				"--provider",
				LOCAL_PROVIDER_ID,
				"--model",
				LOCAL_MODEL_ID,
				"--models",
				`${LOCAL_PROVIDER_ID}/${LOCAL_MODEL_ID}`,
				...rest,
			],
			extensionFactories: [
				{
					name: "midnight-local",
					factory: createLocalProviderExtension(engine, { localOnly: false }),
					hidden: true,
				},
			],
			stop: () => manager.stop(),
		};
	}

	const manager = options.manager ?? new EngineManager({ onStatus: options.onStatus });
	return { mode, args: rest, extensionFactories: hybridExtensions(manager), stop: () => manager.stop() };
}
