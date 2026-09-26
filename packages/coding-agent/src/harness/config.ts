import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";

/**
 * One project check the harness runs before a run may settle. `command` is argv, never a
 * shell string: the harness spawns it directly. `{files}` expands to the changed files
 * that matched `when` (workspace-relative); a check with `when` runs only if some changed
 * file matches, a check without `when` runs after any change.
 */
export interface HarnessCheck {
	name: string;
	command: string[];
	when?: string[];
	timeoutMs: number;
}

export interface MaskingSettings {
	enabled: boolean;
	/** The newest this-many tool results are never elided. */
	keepRecentResults: number;
	/** Results smaller than this are never elided: the stub would save little. */
	minResultBytes: number;
	/**
	 * Elide only once this many bytes are eligible, all at once. Each elision batch changes an
	 * earlier part of the prompt and so invalidates the provider's prompt cache from that point;
	 * batching keeps that to one cache miss per batch instead of one per turn.
	 */
	batchBytes: number;
}

export interface HarnessConfig {
	enabled: boolean;
	checks: HarnessCheck[];
	/** Globs (workspace-relative) the agent's edit and write tools may not touch. */
	protect: string[];
	/** Repair rounds after failed checks before the harness stops and reports. */
	maxRepairRounds: number;
	/** Register the `task` contract tool and hold the run to its acceptance criteria. */
	contract: boolean;
	masking: MaskingSettings;
	/** Tighter prompt, output and sampling defaults when the session model is the local one. */
	localProfile: boolean;
	/**
	 * Timeout applied to shell tool calls that set none (the tools have no default). One
	 * unbounded command, such as `find /` over a whole disk, otherwise stalls the run. 0 disables.
	 */
	shellTimeoutSeconds: number;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 300_000;

export function defaultHarnessConfig(): HarnessConfig {
	return {
		enabled: true,
		checks: [],
		protect: [],
		maxRepairRounds: 2,
		contract: true,
		masking: { enabled: true, keepRecentResults: 6, minResultBytes: 2_000, batchBytes: 48_000 },
		localProfile: true,
		shellTimeoutSeconds: 300,
	};
}

/** The project file the harness reads. It is always protected from the agent's own edits. */
export function harnessConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "harness.json");
}

export class HarnessConfigError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
		throw new HarnessConfigError(`${field} must be an array of non-empty strings`);
	}
	return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new HarnessConfigError(`${field} must be a non-negative integer`);
	}
	return value;
}

function boolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new HarnessConfigError(`${field} must be true or false`);
	return value;
}

function parseCheck(value: unknown, index: number): HarnessCheck {
	const field = `checks[${index}]`;
	if (!isRecord(value)) throw new HarnessConfigError(`${field} must be an object`);
	if (typeof value.name !== "string" || !value.name.trim()) throw new HarnessConfigError(`${field}.name is required`);
	const command = stringArray(value.command, `${field}.command`);
	if (command.length === 0) throw new HarnessConfigError(`${field}.command must not be empty`);
	return {
		name: value.name.trim(),
		command,
		when: value.when === undefined ? undefined : stringArray(value.when, `${field}.when`),
		timeoutMs:
			value.timeoutMs === undefined
				? DEFAULT_CHECK_TIMEOUT_MS
				: nonNegativeInteger(value.timeoutMs, `${field}.timeoutMs`),
	};
}

/** Validate a parsed `harness.json` over the defaults. Unknown keys are rejected so typos surface. */
export function parseHarnessConfig(value: unknown): HarnessConfig {
	const config = defaultHarnessConfig();
	if (!isRecord(value)) throw new HarnessConfigError("harness.json must contain a JSON object");
	const known = new Set([
		"enabled",
		"checks",
		"protect",
		"maxRepairRounds",
		"contract",
		"masking",
		"localProfile",
		"shellTimeoutSeconds",
	]);
	for (const key of Object.keys(value)) {
		if (!known.has(key)) throw new HarnessConfigError(`Unknown key "${key}"`);
	}
	if (value.enabled !== undefined) config.enabled = boolean(value.enabled, "enabled");
	if (value.checks !== undefined) {
		if (!Array.isArray(value.checks)) throw new HarnessConfigError("checks must be an array");
		config.checks = value.checks.map(parseCheck);
	}
	if (value.protect !== undefined) config.protect = stringArray(value.protect, "protect");
	if (value.maxRepairRounds !== undefined)
		config.maxRepairRounds = nonNegativeInteger(value.maxRepairRounds, "maxRepairRounds");
	if (value.contract !== undefined) config.contract = boolean(value.contract, "contract");
	if (value.localProfile !== undefined) config.localProfile = boolean(value.localProfile, "localProfile");
	if (value.shellTimeoutSeconds !== undefined)
		config.shellTimeoutSeconds = nonNegativeInteger(value.shellTimeoutSeconds, "shellTimeoutSeconds");
	if (value.masking !== undefined) {
		if (!isRecord(value.masking)) throw new HarnessConfigError("masking must be an object");
		const masking = value.masking;
		if (masking.enabled !== undefined) config.masking.enabled = boolean(masking.enabled, "masking.enabled");
		if (masking.keepRecentResults !== undefined)
			config.masking.keepRecentResults = nonNegativeInteger(masking.keepRecentResults, "masking.keepRecentResults");
		if (masking.minResultBytes !== undefined)
			config.masking.minResultBytes = nonNegativeInteger(masking.minResultBytes, "masking.minResultBytes");
		if (masking.batchBytes !== undefined)
			config.masking.batchBytes = nonNegativeInteger(masking.batchBytes, "masking.batchBytes");
	}
	return config;
}

/**
 * Resolve the harness config for a session. `MIDNIGHT_SERVER_HARNESS=0` turns the harness
 * off. The project file is read only when the project is trusted: its checks are commands
 * this process will run.
 */
export function loadHarnessConfig(cwd: string, projectTrusted: boolean): HarnessConfig {
	const env = process.env.MIDNIGHT_SERVER_HARNESS;
	if (env === "0" || env?.toLowerCase() === "false") return { ...defaultHarnessConfig(), enabled: false };
	const path = harnessConfigPath(cwd);
	if (!projectTrusted || !existsSync(path)) return defaultHarnessConfig();
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new HarnessConfigError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return parseHarnessConfig(parsed);
	} catch (error) {
		throw new HarnessConfigError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
