import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { FEATURE_NAMES, type FeatureName } from "./features.ts";

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
	/** Extra environment for the check process (detected checks set CI=1 so runners do not watch). */
	env?: Record<string, string>;
	/**
	 * Ladder level: 1 types/lint, 2 related tests, 3 full tests. Lower levels run first and a
	 * failing level stops the ladder, so a type error is reported without a slow test run.
	 * Configured checks without a level are level 1.
	 */
	level?: 1 | 2 | 3;
}

export interface HarnessConfig {
	enabled: boolean;
	checks: HarnessCheck[];
	/** Globs (workspace-relative) the agent's edit and write tools may not touch. */
	protect: string[];
	/** Repair rounds after failed checks before the harness stops and reports. */
	maxRepairRounds: number;
	/**
	 * Timeout applied to shell tool calls that set none (the tools have no default). One
	 * unbounded command, such as `find /` over a whole disk, otherwise stalls the run. 0 disables.
	 */
	shellTimeoutSeconds: number;
	/** Per-feature switches over the defaults (see features.ts). */
	features: Partial<Record<FeatureName, boolean>>;
	/** Checks found from the project's manifests when `checks` is empty (requires project trust). */
	autoChecks: boolean;
	escalation: EscalationSettings;
}

/**
 * Feature `escalation` (opt-in): when the settle checks fail, ask a stronger model for one piece
 * of advice to send with the repair feedback. `model` is `provider/id`.
 */
export interface EscalationSettings {
	model: string;
	/** Advice calls allowed per user prompt. */
	maxCallsPerPrompt: number;
	/** Advice calls allowed per session. */
	maxCallsPerSession: number;
}

export const DEFAULT_ESCALATION_MODEL = "anthropic/claude-opus-5-5";

export const DEFAULT_CHECK_TIMEOUT_MS = 300_000;

export function defaultHarnessConfig(): HarnessConfig {
	return {
		enabled: true,
		checks: [],
		protect: [],
		maxRepairRounds: 1,
		shellTimeoutSeconds: 300,
		features: {},
		autoChecks: true,
		escalation: { model: DEFAULT_ESCALATION_MODEL, maxCallsPerPrompt: 1, maxCallsPerSession: 6 },
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

function ladderLevel(value: unknown, field: string): 1 | 2 | 3 {
	if (value !== 1 && value !== 2 && value !== 3) throw new HarnessConfigError(`${field} must be 1, 2 or 3`);
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
		level: value.level === undefined ? undefined : ladderLevel(value.level, `${field}.level`),
	};
}

/**
 * Validate a parsed `harness.json` over `base` (the defaults). Unknown keys are rejected so typos
 * surface.
 */
export function parseHarnessConfig(value: unknown, base: HarnessConfig = defaultHarnessConfig()): HarnessConfig {
	const config: HarnessConfig = {
		...base,
		checks: [...base.checks],
		protect: [...base.protect],
		features: { ...base.features },
		escalation: { ...base.escalation },
	};
	if (!isRecord(value)) throw new HarnessConfigError("harness.json must contain a JSON object");
	const known = new Set([
		"enabled",
		"checks",
		"protect",
		"maxRepairRounds",
		"shellTimeoutSeconds",
		"features",
		"autoChecks",
		"escalation",
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
	if (value.shellTimeoutSeconds !== undefined)
		config.shellTimeoutSeconds = nonNegativeInteger(value.shellTimeoutSeconds, "shellTimeoutSeconds");
	if (value.autoChecks !== undefined) config.autoChecks = boolean(value.autoChecks, "autoChecks");
	if (value.features !== undefined) {
		if (!isRecord(value.features)) throw new HarnessConfigError("features must be an object");
		for (const [name, enabled] of Object.entries(value.features)) {
			if (!FEATURE_NAMES.includes(name as FeatureName)) {
				throw new HarnessConfigError(`Unknown feature "${name}". Known: ${FEATURE_NAMES.join(", ")}`);
			}
			config.features[name as FeatureName] = boolean(enabled, `features.${name}`);
		}
	}
	if (value.escalation !== undefined) {
		if (!isRecord(value.escalation)) throw new HarnessConfigError("escalation must be an object");
		const escalation = value.escalation;
		for (const key of Object.keys(escalation)) {
			if (!["model", "maxCallsPerPrompt", "maxCallsPerSession"].includes(key)) {
				throw new HarnessConfigError(`Unknown key "escalation.${key}"`);
			}
		}
		if (escalation.model !== undefined) {
			if (typeof escalation.model !== "string" || !/^[^/\s]+\/\S+$/.test(escalation.model)) {
				throw new HarnessConfigError('escalation.model must be "provider/model-id"');
			}
			config.escalation.model = escalation.model;
		}
		if (escalation.maxCallsPerPrompt !== undefined)
			config.escalation.maxCallsPerPrompt = nonNegativeInteger(
				escalation.maxCallsPerPrompt,
				"escalation.maxCallsPerPrompt",
			);
		if (escalation.maxCallsPerSession !== undefined)
			config.escalation.maxCallsPerSession = nonNegativeInteger(
				escalation.maxCallsPerSession,
				"escalation.maxCallsPerSession",
			);
	}
	return config;
}

/**
 * Resolve the harness config for a session. `MIDNIGHT_SERVER_HARNESS=0` turns the harness
 * off. The project file is read only when the project is trusted: its checks are commands
 * this process will run.
 */
export function loadHarnessConfig(
	cwd: string,
	projectTrusted: boolean,
	base: HarnessConfig = defaultHarnessConfig(),
): HarnessConfig {
	const env = process.env.MIDNIGHT_SERVER_HARNESS;
	if (env === "0" || env?.toLowerCase() === "false") return { ...base, enabled: false };
	const path = harnessConfigPath(cwd);
	if (!projectTrusted || !existsSync(path)) return base;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new HarnessConfigError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return parseHarnessConfig(parsed, base);
	} catch (error) {
		throw new HarnessConfigError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
