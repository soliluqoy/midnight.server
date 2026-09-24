import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getPackageDir, isBunBinary } from "../config.ts";
import { ENGINE_LOCK, type EngineLock } from "./pins.ts";

/** Per-user state: downloaded model and engine, verification cache, logs. */
export function getMidnightHome(): string {
	const override = process.env.MIDNIGHT_SERVER_HOME;
	if (override) return resolve(override);
	if (process.platform === "win32" && process.env.LOCALAPPDATA) {
		return join(process.env.LOCALAPPDATA, "midnight.server");
	}
	return join(homedir(), ".local", "share", "midnight.server");
}

/** Directory of the installed distribution (the executable's directory for the compiled binary). */
export function getInstallDir(): string {
	return getPackageDir();
}

export function engineDirName(lock: EngineLock = ENGINE_LOCK): string {
	return `${lock.name}-${lock.release}-${lock.platform}-${lock.backend}`;
}

/**
 * Build output of a source checkout (`packages/coding-agent/../..`). Only used
 * when running from source: for an installed binary this path would point at an
 * unrelated directory outside the installation.
 */
function sourceCheckoutPath(...segments: string[]): string[] {
	return isBunBinary ? [] : [join(getInstallDir(), "..", "..", ...segments)];
}

/**
 * Candidate locations, highest precedence first: explicit override, the offline
 * bundle beside the executable, the per-user download, then (source runs only)
 * the checkout's build output.
 */
export function engineDirCandidates(): string[] {
	const override = process.env.MIDNIGHT_SERVER_ENGINE_DIR;
	if (override) return [resolve(override)];
	return [
		join(getInstallDir(), "engine", ENGINE_LOCK.backend),
		join(getMidnightHome(), "engine", engineDirName()),
		...sourceCheckoutPath("build", "engine", ENGINE_LOCK.backend),
	];
}

/** The host ships with the application; it is never downloaded. */
export function hostCandidates(): string[] {
	return [
		join(getInstallDir(), "engine", "midnight-host.exe"),
		...sourceCheckoutPath("build", "native", "midnight-host.exe"),
	];
}

export function modelCandidates(fileName: string): string[] {
	const override = process.env.MIDNIGHT_SERVER_MODEL;
	if (override) return [resolve(override)];
	return [
		join(getInstallDir(), "models", fileName),
		join(getMidnightHome(), "models", fileName),
		...sourceCheckoutPath("models", "cache", fileName),
	];
}

export function userModelPath(fileName: string): string {
	return join(getMidnightHome(), "models", fileName);
}

export function userEngineDir(): string {
	return join(getMidnightHome(), "engine", engineDirName());
}

export function getLogDir(): string {
	return join(getMidnightHome(), "logs");
}
