import type { InlineExtension } from "../core/extensions/types.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { createDriftWatchExtension, resolveDriftWatchSettings } from "./drift-watch.ts";
import { DEFAULT_CONTEXT_SIZE, resolveEngineSettings } from "./engine.ts";
import { EngineManager, LocalSetupError } from "./engine-manager.ts";
import { createDelegateExtension, createLocalProviderExtension } from "./extension.ts";
import { LOCAL_MODEL_ID, LOCAL_PROVIDER_ID } from "./pins.ts";
import { createSessionTitleExtension } from "./session-title.ts";
import { updateMidnightStatus } from "./status.ts";

export class LocalInferenceUnavailableError extends Error {}

export type MidnightMode = "default" | "local" | "hybrid";

export interface LocalRuntime {
	mode: MidnightMode;
	args: string[];
	extensionFactories: InlineExtension[];
	stop(): Promise<void>;
}

/** Flags and subcommands that print something and exit without running a session. */
const NON_SESSION_FLAGS = ["--help", "-h", "--version", "-v", "--export"];
const NON_SESSION_COMMANDS = ["install", "remove", "uninstall", "update", "list", "config", "auth"];

/** True for invocations that never start a session, so they must not start or download the local engine. */
export function isNonSessionInvocation(args: string[]): boolean {
	return NON_SESSION_COMMANDS.includes(args[0] ?? "") || args.some((arg) => NON_SESSION_FLAGS.includes(arg));
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

function sessionTitleExtension(manager: EngineManager): InlineExtension {
	return { name: "midnight-session-title", factory: createSessionTitleExtension(manager), hidden: true };
}

function localProviderExtension(manager: EngineManager, localOnly: boolean, contextSize: number): InlineExtension {
	return {
		name: "midnight-local",
		factory: createLocalProviderExtension(manager, { localOnly, contextSize }),
		hidden: true,
	};
}

/**
 * The context window the engine will start with. An invalid MIDNIGHT_SERVER_CONTEXT
 * fails when the engine starts; the cloud-led session itself must still start.
 */
function plannedContextSize(): number {
	try {
		return resolveEngineSettings().contextSize;
	} catch {
		return DEFAULT_CONTEXT_SIZE;
	}
}

/** The local model stays selectable with /model; the engine starts when it is first used. */
function hybridExtensions(manager: EngineManager): InlineExtension[] {
	return [
		localProviderExtension(manager, false, plannedContextSize()),
		sessionTitleExtension(manager),
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
	if (isNonSessionInvocation(rest)) {
		return { mode, args: rest, extensionFactories: [], stop: async () => {} };
	}

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
		updateMidnightStatus({ mode: "local" });
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
				localProviderExtension(manager, true, engine.settings.contextSize),
				sessionTitleExtension(manager),
			],
			stop: () => manager.stop(),
		};
	}

	// mode is "default" or "hybrid": try a silent, switchable local fallback only when the
	// caller made no explicit provider/model choice and nothing else is configured.
	// --list-models only reports configured providers; it must not trigger the local fallback.
	const explicitChoice = rest.some((arg) => MODEL_SELECTION_FLAGS.includes(arg) || arg === "--list-models");
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
			updateMidnightStatus({ mode: "hybrid" });
			return { mode, args: rest, extensionFactories: hybridExtensions(manager), stop: () => manager.stop() };
		}
		updateMidnightStatus({ mode: "fallback" });
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
				localProviderExtension(manager, false, engine.settings.contextSize),
				sessionTitleExtension(manager),
			],
			stop: () => manager.stop(),
		};
	}

	const manager = options.manager ?? new EngineManager({ onStatus: options.onStatus });
	updateMidnightStatus({ mode: "hybrid" });
	return { mode, args: rest, extensionFactories: hybridExtensions(manager), stop: () => manager.stop() };
}
