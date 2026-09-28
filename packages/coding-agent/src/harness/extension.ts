import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import { createTwoFilesPatch } from "diff";
import { type Static, Type } from "typebox";
import { CONFIG_DIR_NAME } from "../config.ts";
import type {
	BoundaryResult,
	ExtensionAPI,
	ExtensionContext,
	MessageRenderer,
	SessionBoundaryDraft,
} from "../core/extensions/types.ts";
import { getMidnightStatus } from "../midnight/status.ts";
import { compareWithBaseline } from "./baseline.ts";
import {
	blocks,
	type CheckOutcome,
	expandCommand,
	filesModifiedSince,
	formatCheckFeedback,
	formatCheckSummary,
	matchesAny,
	parsePorcelainZ,
	runCheck,
	type SelectedCheck,
	selectChecks,
	workspaceRelative,
} from "./checks.ts";
import {
	defaultHarnessConfig,
	type HarnessCheck,
	type HarnessConfig,
	HarnessConfigError,
	harnessConfigPath,
	loadHarnessConfig,
} from "./config.ts";
import { buildContextPack, buildFollowUpPack, describeEnvironment } from "./context-pack.ts";
import {
	type DetectedCheck,
	detectProjectChecks,
	expandTests,
	isStaticCheck,
	type ProjectFacts,
} from "./detect-checks.ts";
import {
	actionable,
	BLOCKER_GUIDELINE,
	claimsSuccess,
	detectDrift,
	disclosesDeviation,
	environmentSignals,
	type FileChange,
	formatDriftFeedback,
} from "./drift.ts";
import { LoopGuard, notFoundHint, repairIndentation, suggestPaths, type TextEdit } from "./edit-repair.ts";
import { formatAdvice, requestAdvice } from "./escalate.ts";
import { CONTEXT_PACK_TOKENS, type FeatureName, parseFeatureOverrides, resolveFeatures } from "./features.ts";
import { gitRoot, materializeTree, workingTreeChanges, writeWorkingTree } from "./git.ts";
import { remapForeignPath, repairPowerShellCommand, toolNeedsExistingPath } from "./interface-repair.ts";
import { LspManager } from "./lsp.ts";
import { canCheckSyntax, introducedSyntaxError, pythonInterpreter } from "./parse-gate.ts";
import { formatDiagnostics, newErrors, runLookup } from "./semantic.ts";
import { HarnessTelemetry } from "./telemetry.ts";
import { buildWorkspaceIndex, isTestPath, testsFor, type WorkspaceIndex } from "./workspace-index.ts";

export const CHECK_MESSAGE_TYPE = "harness_check";
export const CONTEXT_MESSAGE_TYPE = "harness_context";
export const ADVICE_MESSAGE_TYPE = "harness_advice";
export const DRIFT_MESSAGE_TYPE = "harness_drift";
export const LOOKUP_TOOL_NAME = "lookup";

const lookupParameters = Type.Object({
	op: Type.Union([Type.Literal("definition"), Type.Literal("references"), Type.Literal("outline")], {
		description:
			"definition: where a symbol is declared, with its body. references: every use of a symbol. outline: the declarations in one file.",
	}),
	symbol: Type.Optional(
		Type.String({ description: "definition/references: the name, e.g. parsePort or Parser.parse." }),
	),
	path: Type.Optional(
		Type.String({ description: "outline: the file. definition/references: optional file to prefer." }),
	),
});

function textOf(content: readonly (TextContent | ImageContent)[]): string {
	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** Edits in an `edit` tool input, in either the current or the legacy single-edit shape. */
function editsOf(input: Record<string, unknown>): TextEdit[] {
	if (Array.isArray(input.edits)) {
		return input.edits.filter(
			(edit): edit is TextEdit =>
				typeof edit === "object" &&
				edit !== null &&
				typeof (edit as TextEdit).oldText === "string" &&
				typeof (edit as TextEdit).newText === "string",
		);
	}
	if (typeof input.oldText === "string" && typeof input.newText === "string") {
		return [input as unknown as TextEdit];
	}
	return [];
}

const SHELL_TOOLS = new Set(["bash", "powershell"]);

interface RunState {
	startedAt?: number;
	/** Files changed in this run and not yet covered by a passing settle check. */
	changed: Set<string>;
	/** Every file changed in this run, for the escalation diff. */
	allChanged: Set<string>;
	shellRan: boolean;
	repairRound: number;
	lastCheckSummary?: string;
	prompt: string;
	loopGuard: LoopGuard;
	escalations: number;
	lastAssistantText?: string;
	/** Files the last settle check covered, and whether it failed. */
	lastChecked: string[];
	lastCheckFailed: boolean;
	/** Each edited file's content before its first edit in this run (undefined: it did not exist). */
	originals: Map<string, string | undefined>;
	/** The working tree at the start of the request (git tree id), for the drift inventory and baselines. */
	startTree?: Promise<string | undefined>;
	/** When a file last changed through edit or write. */
	lastChangeAt?: number;
	/** When a harness check or a test-like shell command last succeeded. */
	verifiedAt?: number;
	/** The drift guard asked to fix or disclose in this request (at most once). */
	driftNudged: boolean;
	/** Shell commands run in this request, for side effects outside the code. */
	shellCommands: string[];
	/** Commands the model ran successfully, with the change epoch right after they ran. */
	passedCommands: Map<string, number>;
}

function freshRun(prompt = ""): RunState {
	return {
		changed: new Set(),
		allChanged: new Set(),
		shellRan: false,
		repairRound: 0,
		prompt,
		loopGuard: new LoopGuard(),
		escalations: 0,
		lastChecked: [],
		lastCheckFailed: false,
		originals: new Map(),
		driftNudged: false,
		shellCommands: [],
		passedCommands: new Map(),
	};
}

/** Shell commands that run a project's tests or checks: their success verifies the change. */
export const TEST_COMMAND =
	/\b(?:test|tests|pytest|vitest|jest|mocha|ava|tap|unittest|go\s+(?:test|vet)|cargo\s+(?:test|check)|tsc|mypy|ruff|eslint|biome|check)\b|node\s+(?:--test\b|\S*test\S*\.m?js)|python\d?\s+\S*test\S*\.py/i;

/** A command line in one canonical spelling, so the model's own run of a check can be recognized. */
export function commandKey(command: string): string {
	return command
		.trim()
		.replace(/\s+/g, " ")
		.replace(/^npm run test\b/, "npm test");
}

/**
 * The harness: cheap guards around Pi's tool calls and one verification pass when a run
 * settles. See docs/harness.md and docs/WORKFLOW_PLAN.md.
 *
 * - Session: environment facts (OS, shell, check commands) in the system prompt, where the
 *   provider caches them.
 * - At each tool call: path, PowerShell and indentation repairs, protected files, syntax errors
 *   rejected in the same turn, closest-match and path hints, repeated calls noticed. Nothing here
 *   spawns a process unless an opt-in feature asks for it.
 * - At settle: the project's checks on the changed files (skipped when the model already ran the
 *   same command after its last change), failures the project already had held back, at most one
 *   repair round, the blocker rule, and the drift guard.
 */
export default function harnessExtension(pi: ExtensionAPI): void {
	let config: HarnessConfig = defaultHarnessConfig();
	let envFeatures: Partial<Record<FeatureName, boolean>> = {};
	let run = freshRun();
	let controller = new AbortController();
	let trusted = false;
	let cwd = process.cwd();
	let facts: ProjectFacts = { languages: [], checks: [] };
	/** Project detection in progress (it probes for Python); requests wait for it. */
	let factsReady: Promise<void> = Promise.resolve();
	let stateGeneration = 0;
	let index: WorkspaceIndex | undefined;
	let indexDirty = true;
	let indexBuild: Promise<WorkspaceIndex> | undefined;
	let packSent = false;
	let lsp: LspManager | undefined;
	/**
	 * Bumped by anything that can change a check's result: a successful edit or write, any shell
	 * command, and each new request. A command the model ran counts for a check only at the same value.
	 */
	let changeEpoch = 0;
	/** Static check results on a start tree, by tree id and argv: an unchanged tree reuses them. */
	const baselineCache = new Map<string, CheckOutcome>();
	const telemetry = new HarnessTelemetry();
	const stats = {
		checkRuns: 0,
		checkFailures: 0,
		checksReused: 0,
		checksKnown: 0,
		repairs: 0,
		escalations: 0,
		escalationCostUsd: 0,
		packs: 0,
		packBytes: 0,
		driftChecks: 0,
		driftNudges: 0,
		blockersAccepted: 0,
	};
	/** Time spent inside each hook, so the harness's own latency is visible (`/harness`, telemetry). */
	const hookMs = new Map<string, { calls: number; ms: number }>();

	async function timed<T>(hook: string, work: () => Promise<T>): Promise<T> {
		const started = performance.now();
		try {
			return await work();
		} finally {
			const ms = performance.now() - started;
			const entry = hookMs.get(hook) ?? { calls: 0, ms: 0 };
			entry.calls++;
			entry.ms += ms;
			hookMs.set(hook, entry);
			if (ms >= 1) telemetry.record({ type: "hook_time", hook, ms: Math.round(ms) });
		}
	}

	function features(): Record<FeatureName, boolean> {
		return resolveFeatures(config.features, envFeatures);
	}

	function on(name: FeatureName): boolean {
		return config.enabled && features()[name];
	}

	/** Checks the harness runs: the project's configured ones, else the detected ones. */
	function activeChecks(): Array<HarnessCheck | DetectedCheck> {
		if (config.checks.length > 0) return config.checks;
		return config.autoChecks && trusted ? facts.checks : [];
	}

	/**
	 * The checks the settle pass runs. Detected full test suites (level 3) are left to the model: on
	 * a real project they are the slowest thing the harness could run. A configured level-3 check runs.
	 */
	function settleChecks(): Array<HarnessCheck | DetectedCheck> {
		const checks = activeChecks();
		return config.checks.length > 0 ? checks : checks.filter((check) => (check.level ?? 1) < 3);
	}

	/**
	 * The workspace index, rebuilt when a change marked it dirty. Concurrent callers share one
	 * build; a change during a build marks the result dirty again for the next caller.
	 */
	function workspace(): Promise<WorkspaceIndex> {
		if (index && !indexDirty) return Promise.resolve(index);
		if (!indexBuild) {
			indexDirty = false;
			const root = cwd;
			indexBuild = buildWorkspaceIndex(root, index)
				.then((built) => {
					if (root === cwd) index = built;
					return built;
				})
				.finally(() => {
					indexBuild = undefined;
				});
		}
		return indexBuild;
	}

	function lspManager(): LspManager | undefined {
		if (!trusted) return undefined;
		lsp ??= new LspManager(cwd);
		return lsp;
	}

	pi.registerTool({
		name: LOOKUP_TOOL_NAME,
		label: "lookup",
		description:
			"Find code by symbol name instead of searching and reading: definition returns where a symbol is declared with its body, references lists every use, outline lists the declarations in a file. Uses the project's language server when available.",
		promptSnippet: "Find a symbol's definition (with body), its references, or a file's outline",
		promptGuidelines: ["To find where something is defined or used, call lookup with its name before grep or read."],
		parameters: lookupParameters,
		executionMode: "parallel",
		async execute(_toolCallId, params: Static<typeof lookupParameters>, signal) {
			const text = await runLookup(params, await workspace(), lspManager(), signal);
			telemetry.record({ type: "lookup", op: params.op });
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	const renderHarnessMessage =
		(tag: string): MessageRenderer =>
		(message, { expanded, outputPad }, theme) => {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			const lines = text.split("\n");
			const shown = expanded
				? lines
				: lines.filter((line, index) => index === 0 || /^\[(FAIL|pass)\]|^\d+\. /.test(line));
			const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
			box.addChild(new Text(`${theme.fg("warning", tag)} ${shown.join("\n")}`, 0, 0));
			return box;
		};
	pi.registerMessageRenderer(CHECK_MESSAGE_TYPE, renderHarnessMessage("[harness]"));
	pi.registerMessageRenderer(ADVICE_MESSAGE_TYPE, renderHarnessMessage("[advice]"));
	pi.registerMessageRenderer(DRIFT_MESSAGE_TYPE, renderHarnessMessage("[drift]"));

	/** Load config, feature overrides and detected checks for the current trust state. */
	function loadState(ctx: ExtensionContext): void {
		cwd = ctx.cwd;
		trusted = ctx.isProjectTrusted();
		try {
			envFeatures = parseFeatureOverrides(process.env.MIDNIGHT_SERVER_HARNESS_FEATURES);
		} catch (error) {
			envFeatures = {};
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
		try {
			config = loadHarnessConfig(ctx.cwd, trusted);
		} catch (error) {
			config = defaultHarnessConfig();
			if (error instanceof HarnessConfigError) ctx.ui.notify(`Harness config ignored: ${error.message}`, "warning");
			else throw error;
		}
		// Detection reads manifests only; the detected commands run only in trusted projects.
		// Finding a Python interpreter spawns processes, so it runs in the background.
		const generation = ++stateGeneration;
		const root = ctx.cwd;
		const withChecks = trusted && config.autoChecks;
		factsReady = (async () => {
			const python = trusted ? await pythonInterpreter() : undefined;
			if (generation !== stateGeneration) return;
			facts = detectProjectChecks(root, { python });
			if (!withChecks) facts = { ...facts, checks: [] };
		})();
		// Awaited before each request; this only keeps a failure from being unhandled until then.
		factsReady.catch(() => undefined);
	}

	let stateLoaded = false;

	pi.on("session_start", (_event, ctx) => {
		stateLoaded = true;
		loadState(ctx);
		index = undefined;
		indexDirty = true;
		packSent = false;
		syncTools();
		// Index in the background while the user types, for the features that read it.
		if (config.enabled && (on("contextPack") || on("lookup") || on("driftGuard"))) {
			void workspace().catch(() => undefined);
		}
	});

	pi.on("session_shutdown", () => {
		controller.abort();
		void lsp?.dispose();
	});

	pi.on("agent_start", () => {
		run.startedAt ??= Date.now();
	});

	pi.on("agent_settled", () => {
		run = freshRun();
	});

	/** Keep the `lookup` tool active only when its feature is on. */
	function syncTools(): void {
		const active = pi.getActiveTools();
		const has = active.includes(LOOKUP_TOOL_NAME);
		if (on("lookup") && !has && getMidnightStatus().agentMode !== "plan") {
			pi.setActiveTools([...active, LOOKUP_TOOL_NAME]);
		} else if (!on("lookup") && has) {
			pi.setActiveTools(active.filter((name) => name !== LOOKUP_TOOL_NAME));
		}
	}

	// Argument repairs made in tool_call, reported to the model with the tool's result.
	const repairNotes = new Map<string, string[]>();
	const addNote = (toolCallId: string, note: string) => {
		const notes = repairNotes.get(toolCallId) ?? [];
		notes.push(note);
		repairNotes.set(toolCallId, notes);
	};
	/** File content before an edit or write, for the parse gate. */
	const beforeEdit = new Map<string, { path: string; before: string | undefined }>();

	pi.on("tool_call", (event, ctx) =>
		timed("tool_call", async () => {
			if (!config.enabled) return;
			const input = event.input as Record<string, unknown> & {
				path?: unknown;
				command?: unknown;
				timeout?: unknown;
			};
			const mutates = event.toolName === "edit" || event.toolName === "write" || SHELL_TOOLS.has(event.toolName);
			// The start tree must not include this request's changes; writing it takes milliseconds
			// and began with the request, so this is normally already resolved.
			if (mutates && run.startTree) await run.startTree;
			if (SHELL_TOOLS.has(event.toolName) && input.timeout === undefined && config.shellTimeoutSeconds > 0) {
				input.timeout = config.shellTimeoutSeconds;
			}
			if (SHELL_TOOLS.has(event.toolName) && typeof input.command === "string") {
				run.shellCommands.push(input.command);
			}
			if (event.toolName === "powershell" && typeof input.command === "string") {
				const repaired = repairPowerShellCommand(input.command);
				if (repaired) {
					input.command = repaired;
					addNote(event.toolCallId, "[harness: rewrote /dev/null redirects as $null for PowerShell]");
				}
			}
			if (typeof input.path === "string") {
				const remapped = remapForeignPath(ctx.cwd, input.path, toolNeedsExistingPath(event.toolName));
				if (remapped) {
					addNote(
						event.toolCallId,
						`[harness: ${input.path} does not exist on this machine; used ${remapped} in the workspace (${ctx.cwd}). Use workspace-relative paths.]`,
					);
					input.path = remapped;
				}
			}
			if (on("loopGuard")) {
				const note = run.loopGuard.call(event.toolName, input);
				if (note) {
					addNote(event.toolCallId, note);
					telemetry.record({ type: "loop_note", tool: event.toolName });
				}
			}
			if (event.toolName !== "edit" && event.toolName !== "write") return;
			const path = input.path;
			if (typeof path !== "string") return;
			const rel = workspaceRelative(ctx.cwd, path);
			if (rel) {
				const configRel = workspaceRelative(ctx.cwd, harnessConfigPath(ctx.cwd));
				if (rel === configRel || matchesAny(rel, config.protect)) {
					return {
						block: true,
						reason: `${rel} is protected by the harness: the user owns it and the agent may not change it. Change the code under test instead, or ask the user to change this file.`,
					};
				}
			}
			const absolute = resolve(ctx.cwd, path);
			let before: string | undefined;
			try {
				before = existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
			} catch {
				before = undefined;
			}
			if (rel && !run.originals.has(rel)) run.originals.set(rel, before);
			if (event.toolName === "edit" && before !== undefined && on("editRepair")) {
				for (const edit of editsOf(input)) {
					const repaired = repairIndentation(before, edit);
					if (!repaired) continue;
					edit.oldText = repaired.oldText;
					edit.newText = repaired.newText;
					addNote(
						event.toolCallId,
						"[harness: oldText matched the file only with different indentation; applied it at the file's real indentation.]",
					);
					telemetry.record({ type: "edit_repair" });
				}
			}
			if (on("parseGate") || on("diagnostics")) beforeEdit.set(event.toolCallId, { path: absolute, before });
			return undefined;
		}),
	);

	pi.on("tool_result", (event, ctx) =>
		timed("tool_result", async () => {
			if (!config.enabled) return;
			const notes = repairNotes.get(event.toolCallId) ?? [];
			repairNotes.delete(event.toolCallId);
			const snapshot = beforeEdit.get(event.toolCallId);
			beforeEdit.delete(event.toolCallId);
			const extra: string[] = [];
			let isError: boolean | undefined;
			let replaceContent: (TextContent | ImageContent)[] | undefined;

			if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
				const path = event.input.path;
				const rel = typeof path === "string" ? workspaceRelative(ctx.cwd, path) : undefined;
				let rejected = false;
				if (snapshot && on("parseGate") && canCheckSyntax(snapshot.path)) {
					let after: string | undefined;
					try {
						after = readFileSync(snapshot.path, "utf8");
					} catch {
						after = undefined;
					}
					const error =
						after === undefined
							? undefined
							: await introducedSyntaxError(snapshot.before, after, snapshot.path, ctx.cwd);
					if (error) {
						if (snapshot.before === undefined) rmSync(snapshot.path, { force: true });
						else writeFileSync(snapshot.path, snapshot.before);
						rejected = true;
						isError = true;
						replaceContent = [
							{
								type: "text",
								text: `Edit rejected by the harness: it makes ${rel ?? snapshot.path} invalid (${error.parser}: ${error.error ?? "syntax error"}). The file is unchanged. Fix the edit so the file still parses, for example by including the matching brackets or quotes.`,
							},
						];
						telemetry.record({ type: "parse_gate_reject", parser: error.parser });
					}
				}
				if (!rejected) changeEpoch++;
				if (!rejected && rel) {
					run.changed.add(rel);
					run.allChanged.add(rel);
					run.lastChangeAt = Date.now();
					indexDirty = true;
					run.loopGuard.noteChange();
					if (snapshot && on("diagnostics") && trusted) {
						const note = await diagnosticsNote(snapshot.path, snapshot.before, rel);
						if (note) extra.push(note);
					}
				}
			}

			if (event.isError) {
				const message = textOf(event.content);
				if (event.toolName === "edit" && /Could not find/.test(message) && on("editRepair")) {
					const path = event.input.path;
					if (typeof path === "string") {
						try {
							const content = readFileSync(resolve(ctx.cwd, path), "utf8");
							const edit = editsOf(event.input as Record<string, unknown>).find(
								(item) => !content.includes(item.oldText),
							);
							const hint = edit ? notFoundHint(path, content, edit.oldText) : undefined;
							if (hint) {
								extra.push(hint);
								telemetry.record({ type: "edit_hint" });
							}
						} catch {
							// No hint.
						}
					}
				}
				const path = (event.input as { path?: unknown }).path;
				if (
					typeof path === "string" &&
					/ENOENT|not found|No such file|does not exist/i.test(message) &&
					on("pathHints")
				) {
					const suggestions = suggestPaths(
						path,
						(await workspace()).files.map((file) => file.path),
					);
					if (suggestions.length > 0) {
						extra.push(`[harness: ${path} does not exist. Did you mean: ${suggestions.join(", ")}?]`);
						telemetry.record({ type: "path_hint" });
					}
				}
				if (SHELL_TOOLS.has(event.toolName) && on("loopGuard")) {
					const command = (event.input as { command?: unknown }).command;
					if (typeof command === "string") {
						const note = run.loopGuard.failure(command, message);
						if (note) {
							extra.push(note);
							telemetry.record({ type: "loop_note", tool: event.toolName });
						}
					}
				}
			}

			if (SHELL_TOOLS.has(event.toolName)) {
				changeEpoch++;
				run.shellRan = true;
				indexDirty = true;
				const command = (event.input as { command?: unknown }).command;
				if (!event.isError) {
					// A command that succeeded may have changed files: rereads and reruns are new information.
					run.loopGuard.noteChange();
					if (typeof command === "string") {
						run.passedCommands.set(commandKey(command), changeEpoch);
						if (TEST_COMMAND.test(command)) run.verifiedAt = Date.now();
					}
				}
			}
			if (notes.length === 0 && extra.length === 0 && !replaceContent) return;
			const content = replaceContent ?? event.content;
			return {
				content: [
					...notes.map((text) => ({ type: "text" as const, text })),
					...content,
					...extra.map((text) => ({ type: "text" as const, text })),
				],
				...(isError !== undefined ? { isError } : {}),
			};
		}),
	);

	/** New language-server errors caused by an edit, or undefined. */
	async function diagnosticsNote(path: string, before: string | undefined, rel: string): Promise<string | undefined> {
		const manager = lspManager();
		if (!manager) return undefined;
		const client = await manager.clientFor(path);
		if (!client) return undefined;
		try {
			const since = Date.now();
			client.sync(path);
			const after = await client.diagnosticsFor(path, since, 8_000);
			if (!after || after.every((item) => (item.severity ?? 1) !== 1)) return undefined;
			let previous: typeof after | undefined;
			if (before !== undefined) {
				const beforeSince = Date.now();
				client.sync(path, before);
				previous = await client.diagnosticsFor(path, beforeSince, 8_000);
				client.sync(path);
			}
			const fresh = newErrors(previous, after);
			if (fresh.length === 0) return undefined;
			telemetry.record({ type: "diagnostics_new", count: fresh.length, server: client.spec.id });
			return formatDiagnostics(rel, fresh, `${client.spec.id} language server`);
		} catch {
			return undefined;
		}
	}

	pi.on("before_agent_start", (event, ctx) =>
		timed("before_agent_start", async () => {
			if (!stateLoaded) {
				stateLoaded = true;
				loadState(ctx);
			}
			// Trust can be granted during a session; checks and servers follow it.
			if (ctx.isProjectTrusted() !== trusted || ctx.cwd !== cwd) loadState(ctx);
			run = freshRun(event.prompt);
			run.startedAt = Date.now();
			changeEpoch++;
			if (!config.enabled) return;
			syncTools();
			const planning = getMidnightStatus().agentMode === "plan";
			if (!planning && (on("driftGuard") || on("checkBaseline"))) {
				run.startTree = writeWorkingTree(ctx.cwd).catch(() => undefined);
			}
			const packing = on("contextPack") && !planning && event.prompt.trim() !== "";
			const indexed = packing ? workspace() : undefined;
			const git = packing && !packSent ? gitSummary(ctx.cwd) : undefined;
			indexed?.catch(() => undefined);
			await factsReady;
			telemetry.record({ type: "features", features: features() });
			const active = pi.getActiveTools();
			event.systemPromptOptions.sections.environment = describeEnvironment({
				facts,
				checks: settleChecks(),
				platform: process.platform,
				shell: active.includes("powershell") ? "powershell" : active.includes("bash") ? "bash" : undefined,
			});
			if (on("blockerExit") && !planning) event.systemPromptOptions.promptGuidelines.push(BLOCKER_GUIDELINE);
			if (!indexed) return;
			try {
				const workspaceIndex = await indexed;
				let text: string | undefined;
				if (!packSent) {
					const window = ctx.model?.contextWindow ?? 0;
					const budget = Math.min(
						CONTEXT_PACK_TOKENS,
						window > 0 ? Math.floor(window * 0.1) : Number.POSITIVE_INFINITY,
					);
					const pack = buildContextPack({
						index: workspaceIndex,
						request: event.prompt,
						git: await git,
						budgetTokens: budget,
					});
					text = pack?.text;
					if (pack) {
						telemetry.record({
							type: "context_pack",
							bytes: pack.bytes,
							inlined: pack.inlined.length,
							files: workspaceIndex.files.length,
						});
					}
				} else {
					text = buildFollowUpPack(workspaceIndex, event.prompt);
				}
				if (!text) return;
				packSent = true;
				stats.packs++;
				stats.packBytes += Buffer.byteLength(text);
				return { message: { customType: CONTEXT_MESSAGE_TYPE, content: text, display: false } };
			} catch (error) {
				telemetry.record({
					type: "context_pack_error",
					message: error instanceof Error ? error.message : String(error),
				});
				return;
			}
		}),
	);

	pi.on("turn_end", (event) => {
		if (!config.enabled || event.message.role !== "assistant") return;
		const text = event.message.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n")
			.trim();
		if (text) run.lastAssistantText = text;
	});

	pi.on("session_compact", () => {
		// Compaction removed earlier results from context: reading them again is not a loop.
		run.loopGuard.forgetCalls();
	});

	async function changedFiles(ctx: ExtensionContext): Promise<string[]> {
		const changed = new Set(run.changed);
		if (run.shellRan && run.startedAt !== undefined) {
			const status = await pi.exec("git", ["status", "--porcelain=v1", "-z", "-uall"], {
				cwd: ctx.cwd,
				timeout: 10_000,
				signal: controller.signal,
			});
			if (status.code === 0) {
				for (const path of await filesModifiedSince(ctx.cwd, parsePorcelainZ(status.stdout), run.startedAt)) {
					changed.add(path);
				}
			}
		}
		return [...changed];
	}

	/** The checks `changed` calls for at one level, with `{tests}` expanded. */
	async function checksAtLevel(
		checks: ReadonlyArray<HarnessCheck | DetectedCheck>,
		level: 1 | 2 | 3,
		changed: readonly string[],
	): Promise<SelectedCheck[]> {
		const levelChecks = checks.filter((check) => (check.level ?? 1) === level);
		if (levelChecks.length === 0) return [];
		const selected: SelectedCheck[] = [];
		let tests: string[] | undefined;
		for (const item of selectChecks(levelChecks, changed)) {
			if (item.check.command.includes("{tests}")) {
				tests ??= testsFor(await workspace(), changed);
				const argv = expandTests(item.check, tests);
				if (!argv) continue;
				selected.push({ ...item, argv });
			} else selected.push(item);
		}
		return selected;
	}

	/**
	 * Run the checks for `changed` level by level, stopping at the first level with a failure. A
	 * check the model already ran with success, with nothing changed since, is not run again.
	 */
	async function runChecks(
		ctx: ExtensionContext,
		changed: readonly string[],
	): Promise<{ outcomes: CheckOutcome[]; failed: CheckOutcome[] } | undefined> {
		const checks = settleChecks();
		if (checks.length === 0 || changed.length === 0) return undefined;
		if (controller.signal.aborted) controller = new AbortController();
		const outcomes: CheckOutcome[] = [];
		for (const level of [1, 2, 3] as const) {
			const selected = await checksAtLevel(checks, level, changed);
			if (selected.length === 0) continue;
			const levelOutcomes: CheckOutcome[] = [];
			for (const item of selected) {
				const argv = item.argv ?? expandCommand(item.check.command, item.files);
				if (run.passedCommands.get(commandKey(argv.join(" "))) === changeEpoch) {
					stats.checksReused++;
					telemetry.record({ type: "check_reused", check: item.check.name });
					levelOutcomes.push({
						name: item.check.name,
						argv,
						passed: true,
						exitCode: 0,
						timedOut: false,
						elapsedMs: 0,
						output: "",
						truncated: false,
					});
					continue;
				}
				ctx.ui.setWorkingMessage(`Harness check: ${item.check.name}...`);
				levelOutcomes.push(await runCheck(item, ctx.cwd, controller.signal));
			}
			ctx.ui.setWorkingMessage();
			if (controller.signal.aborted) return undefined;
			if (levelOutcomes.some((outcome) => !outcome.passed)) {
				outcomes.push(...(await withBaselines(ctx, levelOutcomes)));
			} else outcomes.push(...levelOutcomes);
			// A failure the project already had does not stop the ladder: the tests still run.
			if (outcomes.some(blocks)) break;
		}
		return { outcomes, failed: outcomes.filter(blocks) };
	}

	/**
	 * Compare failing project-wide static checks (types, lint) with the same check on the tree as
	 * the request found it, so a failure the project already had does not become the model's job.
	 * Runs only on this failure path, in a throwaway copy of the start tree (git.ts).
	 */
	async function withBaselines(ctx: ExtensionContext, outcomes: CheckOutcome[]): Promise<CheckOutcome[]> {
		const checks = activeChecks();
		const candidates = outcomes.filter((outcome) => {
			const check = checks.find((item) => item.name === outcome.name);
			return (
				!outcome.passed &&
				!outcome.timedOut &&
				check !== undefined &&
				isStaticCheck(check) &&
				!check.command.some((arg) => arg === "{files}" || arg === "{tests}")
			);
		});
		if (!on("checkBaseline") || candidates.length === 0) return outcomes;
		const tree = await run.startTree;
		if (!tree) return outcomes;
		const root = await gitRoot(ctx.cwd);
		if (!root) return outcomes;
		const baselines = new Map<string, CheckOutcome>();
		let copy: Awaited<ReturnType<typeof materializeTree>>;
		try {
			for (const outcome of candidates) {
				const key = `${tree}\0${outcome.argv.join("\0")}`;
				let before = baselineCache.get(key);
				if (!before) {
					ctx.ui.setWorkingMessage(`Harness check: ${outcome.name} on the tree before this request...`);
					copy ??= await materializeTree(ctx.cwd, tree);
					if (!copy) break;
					const check = checks.find((item) => item.name === outcome.name)!;
					const raw = await runCheck({ check, files: [], argv: outcome.argv }, copy.cwd, controller.signal);
					if (controller.signal.aborted) break;
					// Paths in the copy's output name the real checkout, so errors compare by location.
					const output = [copy.root, copy.root.split(sep).join("/")].reduce(
						(text, from) => text.split(from).join(root),
						raw.output,
					);
					before = { ...raw, output };
					baselineCache.set(key, before);
					telemetry.record({ type: "check_baseline", check: outcome.name, passed: before.passed });
				}
				baselines.set(outcome.name, before);
			}
		} finally {
			ctx.ui.setWorkingMessage();
			await copy?.dispose();
		}
		return outcomes.map((outcome) => {
			const comparison = compareWithBaseline(outcome, baselines.get(outcome.name));
			if (!comparison) return outcome;
			if (comparison.preexisting) {
				stats.checksKnown++;
				telemetry.record({ type: "check_known", check: outcome.name });
			}
			return { ...outcome, baseline: comparison };
		});
	}

	/** Ask the escalation model for advice. Returns the message entry, or undefined. */
	async function escalate(ctx: ExtensionContext, failure: string): Promise<SessionBoundaryDraft | undefined> {
		const settings = config.escalation;
		if (run.escalations >= settings.maxCallsPerPrompt || stats.escalations >= settings.maxCallsPerSession) {
			return undefined;
		}
		const [provider, ...rest] = settings.model.split("/");
		const model = ctx.modelRegistry.find(provider, rest.join("/"));
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return undefined;
		if (ctx.model && model.provider === ctx.model.provider && model.id === ctx.model.id) return undefined;
		run.escalations++;
		stats.escalations++;
		ctx.ui.setWorkingMessage(`Harness: asking ${settings.model} for advice...`);
		try {
			const advice = await requestAdvice(
				(context, signal) => ctx.modelRegistry.complete(model, context, { signal }),
				{
					request: run.prompt,
					diff: await changeDiff(ctx, [...run.allChanged]),
					failure,
					attempt: run.lastAssistantText,
					relevantFiles: [...run.allChanged],
				},
				controller.signal,
			);
			if (!advice) return undefined;
			stats.escalationCostUsd += advice.costUsd;
			telemetry.record({
				type: "escalation",
				model: settings.model,
				costUsd: advice.costUsd,
				input: advice.inputTokens,
				output: advice.outputTokens,
			});
			return {
				type: "custom_message",
				customType: ADVICE_MESSAGE_TYPE,
				content: formatAdvice(settings.model, advice),
				display: true,
			};
		} catch (error) {
			telemetry.record({
				type: "escalation_error",
				message: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		} finally {
			ctx.ui.setWorkingMessage();
		}
	}

	/**
	 * The run's change as a bounded diff. Files edited with edit/write diff against their content
	 * before the run's first edit, so this works without git; files changed only by shell
	 * commands come from `git diff HEAD` when the workspace is a git repository.
	 */
	async function changeDiff(ctx: ExtensionContext, files: readonly string[]): Promise<string> {
		if (files.length === 0) return "";
		const parts: string[] = [];
		const viaGit: string[] = [];
		for (const path of files) {
			if (!run.originals.has(path)) {
				viaGit.push(path);
				continue;
			}
			let current = "";
			try {
				current = existsSync(resolve(ctx.cwd, path)) ? readFileSync(resolve(ctx.cwd, path), "utf8") : "";
			} catch {
				current = "";
			}
			const original = run.originals.get(path);
			parts.push(
				createTwoFilesPatch(
					original === undefined ? "/dev/null" : `a/${path}`,
					`b/${path}`,
					original ?? "",
					current,
					"",
					"",
					{ context: 3 },
				),
			);
		}
		if (viaGit.length > 0) {
			const tracked = await pi.exec("git", ["diff", "--no-color", "HEAD", "--", ...viaGit], {
				cwd: ctx.cwd,
				timeout: 10_000,
				signal: controller.signal,
			});
			if (tracked.code === 0) parts.push(tracked.stdout);
		}
		const diff = parts.join("\n");
		return diff.length > 16_000 ? `${diff.slice(0, 16_000)}\n[... diff truncated ...]` : diff;
	}

	/**
	 * Every file that differs from the start of the request, workspace-relative. With a git
	 * start tree this includes shell edits and deletions; otherwise only edit/write changes.
	 */
	async function driftInventory(ctx: ExtensionContext): Promise<FileChange[]> {
		const inWorkspace = (path: string) => !path.startsWith(`${CONFIG_DIR_NAME}/`);
		const tree = await run.startTree;
		if (tree) {
			const [root, changes] = await Promise.all([gitRoot(ctx.cwd), workingTreeChanges(ctx.cwd, tree)]);
			if (root && changes) {
				return changes.flatMap((change) => {
					const path = workspaceRelative(ctx.cwd, resolve(root, change.path));
					return path && inWorkspace(path) ? [{ ...change, path }] : [];
				});
			}
		}
		return [...run.originals].flatMap(([path, before]) => {
			let after: string | undefined;
			try {
				after = existsSync(resolve(ctx.cwd, path)) ? readFileSync(resolve(ctx.cwd, path), "utf8") : undefined;
			} catch {
				after = undefined;
			}
			return after !== before && inWorkspace(path) ? [{ path, before, after }] : [];
		});
	}

	/**
	 * Background processes this request started, named when a run settles with failing checks: a
	 * process that stands in for a missing service outlives the run, and the user should know.
	 */
	function backgroundNote(): string {
		if (!on("driftGuard")) return "";
		const signal = environmentSignals(run.shellCommands).find((item) => item.kind === "background_process");
		return signal ? `\nNote: ${signal.evidence}.` : "";
	}

	/** Test files as the request found them: the literals a special case would copy from. */
	function testSourcesAtStart(
		ctx: ExtensionContext,
		workspaceIndex: WorkspaceIndex,
		changes: readonly FileChange[],
	): Map<string, string> {
		const sources = new Map<string, string>();
		let bytes = 0;
		for (const change of changes) {
			if (isTestPath(change.path) && change.before !== undefined) sources.set(change.path, change.before);
		}
		for (const file of workspaceIndex.files) {
			if (!file.isTest || sources.has(file.path) || bytes > 1_000_000) continue;
			if (changes.some((change) => change.path === file.path)) continue;
			try {
				const text = readFileSync(resolve(ctx.cwd, file.path), "utf8");
				bytes += text.length;
				sources.set(file.path, text);
			} catch {
				// Unreadable: skip.
			}
		}
		return sources;
	}

	pi.on("agent_before_settle", (event, ctx) => {
		if (!config.enabled || event.outcome !== "completed" || getMidnightStatus().agentMode === "plan") return;
		return timed("settle", async () => {
			// An interrupt during settlement stops the running checks instead of waiting them out.
			if (controller.signal.aborted) controller = new AbortController();
			const settleController = controller;
			const stop = () => settleController.abort();
			event.signal.addEventListener("abort", stop, { once: true });
			try {
				return await settle(ctx);
			} finally {
				event.signal.removeEventListener("abort", stop);
			}
		});
	});

	function stopMessage(content: string): BoundaryResult {
		return { entries: [{ type: "custom_message", customType: CHECK_MESSAGE_TYPE, content, display: true }] };
	}

	async function settle(ctx: ExtensionContext): Promise<BoundaryResult | undefined> {
		let changed = await changedFiles(ctx);
		// Ending again without changes does not fix a failure: check the same files again.
		if (changed.length === 0 && run.lastCheckFailed) changed = run.lastChecked;
		const result = await runChecks(ctx, changed);
		if (result && result.outcomes.length > 0) {
			stats.checkRuns++;
			// Changes up to here are checked; later edits in a repair round re-trigger the checks.
			run.changed.clear();
			run.shellRan = false;
			run.startedAt = Date.now();
			const { outcomes, failed } = result;
			run.lastChecked = changed;
			run.lastCheckFailed = failed.length > 0;
			run.lastCheckSummary = formatCheckSummary(outcomes);
			telemetry.record({ type: "settle_check", passed: failed.length === 0, round: run.repairRound });
			if (failed.length === 0) {
				// Types and lint passing do not back a claim that the tests pass; a test check does.
				const checks = activeChecks();
				const ranTests = outcomes.some((outcome) => {
					const check = checks.find((item) => item.name === outcome.name);
					return check !== undefined && !isStaticCheck(check);
				});
				if (ranTests) run.verifiedAt = Date.now();
			} else {
				stats.checkFailures++;
				// The sanctioned stop: after a repair round, a model that reports why the checks cannot
				// pass (a conflicting test, a missing dependency) is not pushed again. More rounds are the
				// pressure that turns an honest blocker into a special case or an undone request.
				if (
					on("blockerExit") &&
					run.repairRound >= 1 &&
					disclosesDeviation(run.lastAssistantText) &&
					!claimsSuccess(run.lastAssistantText)
				) {
					stats.blockersAccepted++;
					telemetry.record({ type: "blocker_accepted", round: run.repairRound });
					return stopMessage(
						`Harness checks still fail, and the agent's last message says why; no further repair rounds.\n${run.lastCheckSummary}${backgroundNote()}`,
					);
				}
				if (run.repairRound >= config.maxRepairRounds) {
					return stopMessage(
						`Harness checks still fail after ${config.maxRepairRounds} repair round(s); stopping here. Tell the user what fails and why.\n${run.lastCheckSummary}${backgroundNote()}`,
					);
				}
				run.repairRound++;
				stats.repairs++;
				const entries: SessionBoundaryDraft[] = [
					{
						type: "custom_message",
						customType: CHECK_MESSAGE_TYPE,
						content: formatCheckFeedback(outcomes, run.repairRound, config.maxRepairRounds, on("blockerExit")),
						display: true,
					},
				];
				if (on("escalation")) {
					const advice = await escalate(
						ctx,
						failed.map((outcome) => `${outcome.name}:\n${outcome.output}`).join("\n\n"),
					);
					if (advice) entries.push(advice);
				}
				return { entries, continue: true };
			}
		}

		// Implementation drift, once the checks pass or there are none: failing checks already send
		// the model back, and weakening a test to get past them shows up here on the next settle.
		if (!on("driftGuard") || run.lastCheckFailed || run.driftNudged) return undefined;
		const changes = await driftInventory(ctx);
		if (changes.length === 0 && run.shellCommands.length === 0) return undefined;
		const workspaceIndex = await workspace();
		const signals = detectDrift({
			request: run.prompt,
			changes,
			finalMessage: run.lastAssistantText,
			verification: {
				verifiedAfterLastChange:
					run.verifiedAt !== undefined && run.verifiedAt >= (run.lastChangeAt ?? run.startedAt ?? 0),
				lastCheckFailed: run.lastCheckFailed,
			},
			testSources: testSourcesAtStart(ctx, workspaceIndex, changes),
			workspaceFiles: workspaceIndex.files
				.map((file) => file.path)
				.filter((path) => !changes.some((change) => change.path === path && change.before === undefined)),
			shellCommands: run.shellCommands,
		});
		const flagged = actionable(signals);
		stats.driftChecks++;
		telemetry.record({
			type: "drift_check",
			kinds: signals.map((signal) => signal.kind),
			actionable: flagged.length,
			disclosed: disclosesDeviation(run.lastAssistantText),
		});
		if (flagged.length === 0) return undefined;
		run.driftNudged = true;
		stats.driftNudges++;
		return {
			entries: [
				{
					type: "custom_message",
					customType: DRIFT_MESSAGE_TYPE,
					content: formatDriftFeedback(flagged),
					display: true,
				},
			],
			continue: true,
		};
	}

	pi.registerCommand("harness", {
		description: "Show the harness state: features, checks, time spent and escalation cost",
		handler: async (_args, ctx) => {
			if (!config.enabled) {
				ctx.ui.notify("Harness is off (MIDNIGHT_SERVER_HARNESS=0 or enabled: false in harness.json).");
				return;
			}
			const resolved = features();
			const checks = activeChecks();
			const onList = (value: boolean) =>
				Object.entries(resolved)
					.filter(([, enabled]) => enabled === value)
					.map(([name]) => name)
					.join(", ") || "none";
			const lines = [
				`Harness config: ${harnessConfigPath(ctx.cwd)}${ctx.isProjectTrusted() ? "" : " (project not trusted: project checks, detected checks and language servers are off)"}`,
				`Features on: ${onList(true)}`,
				`Features off: ${onList(false)}`,
				`Checks: ${checks.length > 0 ? checks.map((check) => `${check.name} (level ${check.level ?? 1}${"source" in check ? `, from ${check.source}` : ""})`).join(", ") : "none configured or detected"}`,
				`Protected: ${["harness.json", ...config.protect].join(", ")}`,
				`Check runs: ${stats.checkRuns} (${stats.checkFailures} failed, ${stats.repairs} repair rounds, ${stats.checksReused} reused from the model's own runs, ${stats.checksKnown} failures held back as pre-existing)`,
				`Drift: ${stats.driftChecks} check(s), ${stats.driftNudges} fix-or-disclose request(s), ${stats.blockersAccepted} reported blocker(s) accepted`,
				`Context packs: ${stats.packs} (${(stats.packBytes / 1024).toFixed(1)} KB)`,
				`Escalation: ${on("escalation") ? config.escalation.model : "off"}, ${stats.escalations} call(s), $${stats.escalationCostUsd.toFixed(4)}`,
				`Time in harness: ${
					[...hookMs.entries()]
						.map(([hook, entry]) => `${hook} ${(entry.ms / 1000).toFixed(2)} s over ${entry.calls}`)
						.join(", ") || "none yet"
				}`,
				`Language servers: ${lsp?.running.join(", ") || "none running"}`,
				`Events: ${telemetry.summary()}`,
			];
			ctx.ui.notify(lines.join("\n"));
		},
	});
}

async function gitSummary(cwd: string): Promise<{ branch?: string; changed: string[] } | undefined> {
	const stdout = await new Promise<string | undefined>((done) => {
		execFile(
			"git",
			["status", "--porcelain=v1", "-z", "--branch"],
			{ cwd, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
			(error, out) => done(error ? undefined : out),
		);
	});
	if (stdout === undefined) return undefined;
	const [header, ...rest] = stdout.split("\0");
	const branch = /^## (?:No commits yet on )?([^.\s]+)/.exec(header ?? "")?.[1];
	// The harness's own config directory is not a change the model should look at.
	const changed = parsePorcelainZ(rest.join("\0")).filter((path) => !path.startsWith(`${CONFIG_DIR_NAME}/`));
	return { branch, changed };
}
