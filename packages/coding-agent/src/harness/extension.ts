import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import { createTwoFilesPatch } from "diff";
import { type Static, Type } from "typebox";
import { CONFIG_DIR_NAME } from "../config.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageRenderer,
	SessionBoundaryDraft,
} from "../core/extensions/types.ts";
import { LOCAL_PROVIDER_ID } from "../midnight/pins.ts";
import { getMidnightStatus } from "../midnight/status.ts";
import { CheckpointStore, gitRoot, isGitWorkTree, workingTreeChanges, writeWorkingTree } from "./checkpoints.ts";
import {
	type CheckOutcome,
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
import { buildContextPack, buildFollowUpPack } from "./context-pack.ts";
import {
	createContract,
	formatContract,
	latestContract,
	openCriteria,
	TASK_TOOL_NAME,
	type TaskContract,
	updateContract,
} from "./contract.ts";
import {
	compactReviewState,
	type DecisionBackend,
	decisionBackendFromEnv,
	formatReviewFeedback,
	INTAKE_QUESTIONS,
	INTAKE_VERSION,
	intakeNote,
	REVIEW_QUESTIONS,
	REVIEW_VERSION,
	reviewPolicy,
	stateDigest,
} from "./decisions.ts";
import { type DetectedCheck, detectProjectChecks, expandTests, type ProjectFacts } from "./detect-checks.ts";
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
import {
	CONTEXT_PACK_TOKENS,
	classifyModel,
	type FeatureName,
	type ModelClass,
	parseFeatureOverrides,
	resolveFeatures,
} from "./features.ts";
import { remapForeignPath, repairPowerShellCommand, toolNeedsExistingPath } from "./interface-repair.ts";
import { capToolOutput, LOCAL_TOOLS, splitContextFiles, withGreedyDefault } from "./local-profile.ts";
import { LspManager } from "./lsp.ts";
import { planMasking } from "./masking.ts";
import { canCheckSyntax, introducedSyntaxError, pythonInterpreter } from "./parse-gate.ts";
import { formatDiagnostics, newErrors, runLookup } from "./semantic.ts";
import { HarnessTelemetry } from "./telemetry.ts";
import { buildWorkspaceIndex, isTestPath, testsFor, type WorkspaceIndex } from "./workspace-index.ts";

export const CHECK_MESSAGE_TYPE = "harness_check";
export const CONTRACT_MESSAGE_TYPE = "harness_contract";
export const CONTEXT_MESSAGE_TYPE = "harness_context";
export const ADVICE_MESSAGE_TYPE = "harness_advice";
export const REVIEW_MESSAGE_TYPE = "harness_review";
export const DRIFT_MESSAGE_TYPE = "harness_drift";
export const LOOKUP_TOOL_NAME = "lookup";

const taskParameters = Type.Object({
	action: Type.Union([Type.Literal("set"), Type.Literal("update")], {
		description: "set: start or replace the contract. update: change criteria and plan step status.",
	}),
	objective: Type.Optional(
		Type.String({ description: "set: what the user wants, including what they implied but did not say." }),
	),
	constraints: Type.Optional(
		Type.Array(Type.String(), { description: "set: limits the user gave or the codebase imposes." }),
	),
	criteria: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"set: acceptance criteria you can check, such as a command that must pass or a behavior to observe.",
		}),
	),
	plan: Type.Optional(Type.Array(Type.String(), { description: "set: short ordered steps (optional)." })),
	mark: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Integer({ minimum: 1, description: "1-based criterion number." }),
				status: Type.Union([Type.Literal("met"), Type.Literal("unmet"), Type.Literal("waived")]),
				evidence: Type.String({
					description: "What you observed that shows it: a command and its result, a file and line.",
				}),
			}),
			{ description: "update: criteria to mark." },
		),
	),
	steps: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Integer({ minimum: 1, description: "1-based plan step number." }),
				status: Type.Union([
					Type.Literal("todo"),
					Type.Literal("doing"),
					Type.Literal("done"),
					Type.Literal("dropped"),
				]),
				note: Type.Optional(Type.String()),
			}),
			{ description: "update: plan steps to mark." },
		),
	),
	addCriteria: Type.Optional(Type.Array(Type.String(), { description: "update: criteria discovered while working." })),
	addSteps: Type.Optional(Type.Array(Type.String(), { description: "update: plan steps to append." })),
});

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

function branchMessages(ctx: ExtensionContext): AgentMessage[] {
	return ctx.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

function isLocalModel(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === LOCAL_PROVIDER_ID;
}

function textOf(content: readonly (TextContent | ImageContent)[]): string {
	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function contractReminder(contract: TaskContract, checkSummary: string | undefined): string {
	const open = openCriteria(contract);
	const lines = [
		"Before you finish: the task contract still has criteria that are not shown met.",
		...open.map(
			({ id, criterion }) => `${id}. ${criterion.text}${criterion.status === "unmet" ? " (marked unmet)" : ""}`,
		),
	];
	if (checkSummary) lines.push("", "Harness checks on your changes:", checkSummary);
	lines.push(
		"",
		"Verify each one now (run the command, read the result) and mark it with the task tool: met with the evidence you observed, or unmet or waived with the reason. If one cannot be met, tell the user plainly instead of claiming success.",
	);
	return lines.join("\n");
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

interface RunState {
	startedAt?: number;
	/** Files changed in this run and not yet covered by a passing settle check. */
	changed: Set<string>;
	/** Files changed since the last in-run check. */
	changedSinceInRun: Set<string>;
	/** Every file changed in this run, for the escalation diff and telemetry. */
	allChanged: Set<string>;
	shellRan: boolean;
	repairRound: number;
	lastFailedKey?: string;
	contractNudged: boolean;
	lastCheckSummary?: string;
	lastFailureText?: string;
	prompt: string;
	loopGuard: LoopGuard;
	escalations: number;
	loopEscalated: boolean;
	lastAssistantText?: string;
	/** Files the last settle check covered, and whether it failed. */
	lastChecked: string[];
	lastCheckFailed: boolean;
	/** The independent review ran for this prompt (it runs at most once). */
	reviewed: boolean;
	/** Each edited file's content before its first edit in this run (undefined: it did not exist). */
	originals: Map<string, string | undefined>;
	/** The working tree at the start of the request (git tree id), for the drift inventory. */
	baselineTree?: string;
	/** When a file last changed through edit or write. */
	lastChangeAt?: number;
	/** When a harness check or a test-like shell command last succeeded. */
	verifiedAt?: number;
	/** The drift guard asked to fix or disclose in this request (at most once). */
	driftNudged: boolean;
	/** Shell commands run in this request, for side effects outside the code. */
	shellCommands: string[];
}

function freshRun(prompt = ""): RunState {
	return {
		changed: new Set(),
		changedSinceInRun: new Set(),
		allChanged: new Set(),
		shellRan: false,
		repairRound: 0,
		contractNudged: false,
		prompt,
		loopGuard: new LoopGuard(),
		escalations: 0,
		loopEscalated: false,
		lastChecked: [],
		lastCheckFailed: false,
		reviewed: false,
		originals: new Map(),
		driftNudged: false,
		shellCommands: [],
	};
}

/** Shell commands that run a project's tests or checks: their success verifies the change. */
const TEST_COMMAND =
	/(?:test|tests|pytest|vitest|jest|mocha|ava|tap|unittest|gos+(?:test|vet)|cargos+(?:test|check)|tsc|mypy|ruff|eslint|biome|check)|nodes+(?:--test|S*testS*.m?js)|pythond?s+S*testS*.py/i;

/** In-run checks skip any check that took longer than this last time: they must stay cheap. */
const IN_RUN_CHECK_BUDGET_MS = 90_000;

/**
 * The harness: work moved out of the model and into code, so a model spends its tokens on
 * the task instead of on exploring, recovering and double-checking. See docs/harness.md.
 *
 * - Before the first request: a context pack (environment, ranked files, their contents).
 * - At each action: path, PowerShell and indentation repairs; syntax errors rejected in the
 *   same turn; new language-server errors reported with the edit; repeated calls noticed.
 * - After edits: project checks (configured or detected), cheapest first, during the run and
 *   before it settles, with bounded repair rounds, rollback to the last passing state, and
 *   advice from a stronger model when a fast model is stuck.
 * - Always: protected files, observation masking scaled to the context window.
 *
 * Features switch per model class (fast, frontier, local) and per flag; see features.ts.
 */
export default function harnessExtension(pi: ExtensionAPI): void {
	let config: HarnessConfig = defaultHarnessConfig();
	let envFeatures: Partial<Record<FeatureName, boolean>> = {};
	let run = freshRun();
	let controller = new AbortController();
	let trusted = false;
	let cwd = process.cwd();
	let facts: ProjectFacts = { languages: [], checks: [] };
	let index: WorkspaceIndex | undefined;
	let indexDirty = true;
	let packSent = false;
	let lsp: LspManager | undefined;
	let checkpoints: CheckpointStore | undefined;
	let lastGreen: ReturnType<CheckpointStore["snapshot"]>;
	let decisions: DecisionBackend | undefined;
	const checkDurations = new Map<string, number>();
	const telemetry = new HarnessTelemetry();
	const stats = {
		maskBatches: 0,
		elidedBytes: 0,
		checkRuns: 0,
		checkFailures: 0,
		repairs: 0,
		contractNudges: 0,
		escalations: 0,
		escalationCostUsd: 0,
		rollbacks: 0,
		packs: 0,
		packBytes: 0,
		reviews: 0,
		revisions: 0,
		driftChecks: 0,
		driftNudges: 0,
		blockersAccepted: 0,
	};

	function modelClass(ctx: ExtensionContext): ModelClass {
		return classifyModel(ctx.model);
	}

	function features(ctx: ExtensionContext): Record<FeatureName, boolean> {
		const fromConfig: Partial<Record<FeatureName, boolean>> = {
			contract: config.contract,
			masking: config.masking.enabled,
			localProfile: config.localProfile,
			...config.features,
		};
		const resolved = resolveFeatures(modelClass(ctx), fromConfig, envFeatures);
		// The local profile only ever applies to the local model.
		if (!isLocalModel(ctx)) resolved.localProfile = false;
		return resolved;
	}

	function on(ctx: ExtensionContext, name: FeatureName): boolean {
		return config.enabled && features(ctx)[name];
	}

	/** Checks the harness runs: the project's configured ones, else the detected ones. */
	function activeChecks(): Array<HarnessCheck | DetectedCheck> {
		if (config.checks.length > 0) return config.checks;
		return config.autoChecks && trusted ? facts.checks : [];
	}

	function workspace(): WorkspaceIndex {
		if (!index || indexDirty) {
			index = buildWorkspaceIndex(cwd, index);
			indexDirty = false;
		}
		return index;
	}

	function lspManager(): LspManager | undefined {
		if (!trusted) return undefined;
		lsp ??= new LspManager(cwd);
		return lsp;
	}

	function checkpointStore(): CheckpointStore | undefined {
		if (checkpoints === undefined && isGitWorkTree(cwd)) {
			checkpoints = new CheckpointStore(cwd, `${process.pid}-${Date.now().toString(36)}`);
		}
		return checkpoints;
	}

	pi.registerTool({
		name: TASK_TOOL_NAME,
		label: "task",
		description:
			"Record and track the task contract: the user's objective as you understand it, their constraints, and checkable acceptance criteria. action=set starts or replaces it; action=update marks criteria met, unmet or waived with evidence and tracks plan steps. Before you finish, the harness shows any criterion not yet shown met.",
		promptSnippet:
			"Record the task's objective, constraints and checkable acceptance criteria; mark them with evidence",
		promptGuidelines: [
			"For a task beyond a quick answer or a one-line change, call task (action=set) before editing: restate the objective including what the user implied, list constraints, and write acceptance criteria you can check.",
			"If the request is ambiguous in a way that changes the result, ask the user instead of guessing.",
			"Mark a criterion met only with evidence you observed in this session, such as a command's result or a file and line.",
		],
		parameters: taskParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params: Static<typeof taskParameters>, _signal, _onUpdate, ctx) {
			const previous = latestContract(branchMessages(ctx));
			let contract: TaskContract;
			if (params.action === "set") {
				contract = createContract(
					{
						objective: params.objective ?? "",
						constraints: params.constraints,
						criteria: params.criteria ?? [],
						plan: params.plan,
					},
					previous,
				);
			} else {
				if (!previous) throw new Error("No task contract yet. Call task with action=set first.");
				contract = updateContract(previous, {
					criteria: params.mark,
					steps: params.steps,
					addCriteria: params.addCriteria,
					addSteps: params.addSteps,
				});
			}
			return { content: [{ type: "text", text: formatContract(contract) }], details: contract };
		},
	});

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
			const text = await runLookup(params, workspace(), lspManager(), signal);
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
	pi.registerMessageRenderer(CONTRACT_MESSAGE_TYPE, renderHarnessMessage("[contract]"));
	pi.registerMessageRenderer(ADVICE_MESSAGE_TYPE, renderHarnessMessage("[advice]"));
	pi.registerMessageRenderer(REVIEW_MESSAGE_TYPE, renderHarnessMessage("[review]"));
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
		decisions ??= decisionBackendFromEnv();
		// Detection reads manifests only; the detected commands run only in trusted projects.
		facts = detectProjectChecks(ctx.cwd, { python: trusted ? pythonInterpreter() : undefined });
		if (!trusted || !config.autoChecks) facts = { ...facts, checks: [] };
	}

	pi.on("session_start", (_event, ctx) => {
		loadState(ctx);
		index = undefined;
		indexDirty = true;
		packSent = false;
		lastGreen = undefined;
		syncTools(ctx);
		// A managed Laya server loads its checkpoint in the background; decisions start once it answers.
		if (on(ctx, "decisions")) decisions?.warmUp?.();
	});

	pi.on("session_shutdown", () => {
		controller.abort();
		void lsp?.dispose();
		checkpoints?.dispose();
		decisions?.dispose?.();
	});

	pi.on("agent_start", () => {
		run.startedAt ??= Date.now();
	});

	pi.on("agent_settled", () => {
		run = freshRun();
	});

	/** Keep the harness's own tools active only when their features are on for this model. */
	function syncTools(ctx: ExtensionContext): void {
		const active = new Set(pi.getActiveTools());
		const want: Array<[string, boolean]> = [
			[TASK_TOOL_NAME, on(ctx, "contract")],
			[LOOKUP_TOOL_NAME, on(ctx, "lookup")],
		];
		let changed = false;
		for (const [name, enabled] of want) {
			if (enabled && !active.has(name) && getMidnightStatus().agentMode !== "plan") {
				active.add(name);
				changed = true;
			} else if (!enabled && active.has(name)) {
				active.delete(name);
				changed = true;
			}
		}
		if (changed) pi.setActiveTools([...active]);
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

	pi.on("tool_call", (event, ctx) => {
		if (!config.enabled) return;
		const input = event.input as Record<string, unknown> & { path?: unknown; command?: unknown; timeout?: unknown };
		if (
			(event.toolName === "bash" || event.toolName === "powershell") &&
			input.timeout === undefined &&
			config.shellTimeoutSeconds > 0
		) {
			input.timeout = config.shellTimeoutSeconds;
		}
		if ((event.toolName === "bash" || event.toolName === "powershell") && typeof input.command === "string") {
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
		if (on(ctx, "loopGuard")) {
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
		if (event.toolName === "edit" && before !== undefined && on(ctx, "editRepair")) {
			const edits = editsOf(input);
			for (const edit of edits) {
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
		if (on(ctx, "parseGate") || on(ctx, "diagnostics")) beforeEdit.set(event.toolCallId, { path: absolute, before });
	});

	pi.on("tool_result", async (event, ctx) => {
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
			if (snapshot && on(ctx, "parseGate") && canCheckSyntax(snapshot.path)) {
				let after: string | undefined;
				try {
					after = readFileSync(snapshot.path, "utf8");
				} catch {
					after = undefined;
				}
				const error =
					after === undefined ? undefined : introducedSyntaxError(snapshot.before, after, snapshot.path, ctx.cwd);
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
			if (!rejected && rel) {
				run.changed.add(rel);
				run.changedSinceInRun.add(rel);
				run.allChanged.add(rel);
				run.lastChangeAt = Date.now();
				indexDirty = true;
				run.loopGuard.noteChange();
				if (snapshot && on(ctx, "diagnostics") && trusted) {
					const note = await diagnosticsNote(snapshot.path, snapshot.before, rel);
					if (note) extra.push(note);
				}
			}
		}

		if (event.isError) {
			const message = textOf(event.content);
			if (event.toolName === "edit" && /Could not find/.test(message) && on(ctx, "editRepair")) {
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
				on(ctx, "pathHints")
			) {
				const suggestions = suggestPaths(
					path,
					workspace().files.map((file) => file.path),
				);
				if (suggestions.length > 0) {
					extra.push(`[harness: ${path} does not exist. Did you mean: ${suggestions.join(", ")}?]`);
					telemetry.record({ type: "path_hint" });
				}
			}
			if ((event.toolName === "bash" || event.toolName === "powershell") && on(ctx, "loopGuard")) {
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

		if (event.toolName === "bash" || event.toolName === "powershell") {
			run.shellRan = true;
			indexDirty = true;
			// A command that succeeded may have changed files: rereads and reruns are new information.
			if (!event.isError) run.loopGuard.noteChange();
			const command = (event.input as { command?: unknown }).command;
			if (!event.isError && typeof command === "string" && TEST_COMMAND.test(command)) run.verifiedAt = Date.now();
		}
		const capped =
			on(ctx, "localProfile") && isLocalModel(ctx) && event.toolName !== TASK_TOOL_NAME
				? capToolOutput(replaceContent ?? event.content, event.toolName)
				: undefined;
		if (notes.length === 0 && extra.length === 0 && !capped && !replaceContent) return;
		const content = capped ?? replaceContent ?? event.content;
		return {
			content: [
				...notes.map((text) => ({ type: "text" as const, text })),
				...content,
				...extra.map((text) => ({ type: "text" as const, text })),
			],
			...(isError !== undefined ? { isError } : {}),
		};
	});

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

	pi.on("before_provider_request", (event, ctx) => {
		if (!on(ctx, "localProfile") || !isLocalModel(ctx)) return;
		return withGreedyDefault(event.payload);
	});

	// Tools the local profile hid, restored as soon as a different model drives the session.
	let hiddenTools: string[] = [];
	pi.on("before_agent_start", async (event, ctx) => {
		// Trust can be granted during a session; checks and servers follow it.
		if (ctx.isProjectTrusted() !== trusted || ctx.cwd !== cwd) loadState(ctx);
		run = freshRun(event.prompt);
		run.startedAt = Date.now();
		// A passing state from an earlier request predates whatever the user did since.
		lastGreen = undefined;
		if (!config.enabled) {
			delete event.systemPromptOptions.sections.project_files;
			return;
		}
		syncTools(ctx);
		// What this request actually runs with, so an experiment can check it against its assignment.
		telemetry.record({ type: "features", modelClass: modelClass(ctx), features: features(ctx) });
		const planning = getMidnightStatus().agentMode === "plan";
		if (on(ctx, "blockerExit") && !planning) event.systemPromptOptions.promptGuidelines.push(BLOCKER_GUIDELINE);
		// The drift inventory compares against the tree as the request found it, so edits made by
		// shell commands count too. Outside git, it falls back to files changed through edit/write.
		if (on(ctx, "driftGuard") && !planning && isGitWorkTree(ctx.cwd)) run.baselineTree = writeWorkingTree(ctx.cwd);
		if (!on(ctx, "localProfile") || !isLocalModel(ctx)) {
			if (hiddenTools.length > 0) {
				pi.setActiveTools([...new Set([...pi.getActiveTools(), ...hiddenTools])]);
				hiddenTools = [];
				syncTools(ctx);
			}
			delete event.systemPromptOptions.sections.project_files;
		} else {
			const active = pi.getActiveTools();
			const removed = active.filter((name) => !LOCAL_TOOLS.has(name));
			if (removed.length > 0) {
				pi.setActiveTools(active.filter((name) => LOCAL_TOOLS.has(name)));
				hiddenTools = [...new Set([...hiddenTools, ...removed])];
			}
			const { keep, note } = splitContextFiles(event.systemPromptOptions.contextFiles);
			event.systemPromptOptions.contextFiles = keep;
			if (note) event.systemPromptOptions.sections.project_files = note;
			else delete event.systemPromptOptions.sections.project_files;
		}
		if (!on(ctx, "contextPack") || getMidnightStatus().agentMode === "plan" || !event.prompt.trim()) return;
		try {
			const started = Date.now();
			const workspaceIndex = workspace();
			let text: string | undefined;
			if (!packSent) {
				const window = ctx.model?.contextWindow ?? 0;
				const budget = Math.min(
					CONTEXT_PACK_TOKENS[modelClass(ctx)],
					window > 0 ? Math.floor(window * 0.1) : Number.POSITIVE_INFINITY,
				);
				const active = pi.getActiveTools();
				const pack = buildContextPack({
					index: workspaceIndex,
					request: event.prompt,
					facts,
					checks: activeChecks(),
					platform: process.platform,
					shell: active.includes("powershell") ? "powershell" : active.includes("bash") ? "bash" : undefined,
					git: gitSummary(ctx.cwd),
					budgetTokens: budget,
				});
				text = pack?.text;
				if (pack && decisions && on(ctx, "decisions")) {
					const intake = await askDecisions(
						INTAKE_VERSION,
						{
							request: event.prompt.slice(0, 6_000),
							candidates: pack.ranked.slice(0, 8),
						},
						INTAKE_QUESTIONS,
					);
					const { note } = intake ? intakeNote(intake) : { note: undefined };
					if (note) text = `${text}\n\n${note}`;
				}
				if (pack) {
					telemetry.record({
						type: "context_pack",
						bytes: pack.bytes,
						inlined: pack.inlined.length,
						files: workspaceIndex.files.length,
						ms: Date.now() - started,
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
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!config.enabled) return;
		if (event.message.role === "assistant") {
			const text = event.message.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n")
				.trim();
			if (text) run.lastAssistantText = text;
		}
		const entries: SessionBoundaryDraft[] = [];
		if (on(ctx, "masking")) {
			const plan = planMasking(event.context.contextEntries, config.masking, ctx.model?.contextWindow);
			if (plan.edits.length > 0) {
				stats.maskBatches++;
				stats.elidedBytes += plan.elidedBytes;
				telemetry.record({ type: "mask_batch", bytes: plan.elidedBytes, results: plan.edits.length });
				entries.push(...plan.edits);
				// The stubs tell the model to call again for elided content; that is not a loop.
				run.loopGuard.forgetCalls();
			}
		}
		const continuing =
			event.message.role === "assistant" && event.message.content.some((part) => part.type === "toolCall");
		if (
			continuing &&
			on(ctx, "inRunChecks") &&
			run.changedSinceInRun.size > 0 &&
			getMidnightStatus().agentMode !== "plan"
		) {
			const changed = [...run.changedSinceInRun];
			run.changedSinceInRun.clear();
			const result = await runLadder(ctx, changed, 2, true);
			if (result && result.outcomes.length > 0) {
				telemetry.record({
					type: "inrun_check",
					passed: result.failed.length === 0,
					checks: result.outcomes.length,
				});
				if (result.failed.length === 0) run.verifiedAt = Date.now();
				if (result.failed.length === 0 && on(ctx, "checkpoints")) {
					lastGreen = checkpointStore()?.snapshot("checks passed during the run") ?? lastGreen;
				}
				entries.push({
					type: "custom_message",
					customType: CHECK_MESSAGE_TYPE,
					content:
						result.failed.length === 0
							? `Harness checks after your edits pass:\n${formatCheckSummary(result.outcomes)}\nYou do not need to rerun them yourself.`
							: `Harness checks after your edits:\n${formatCheckFeedback(result.outcomes, 0, 0, false, on(ctx, "blockerExit")).split("\n").slice(1).join("\n")}`,
					display: true,
				});
			}
		}
		if (continuing && on(ctx, "escalation") && !run.loopEscalated && run.loopGuard.loops >= 3) {
			run.loopEscalated = true;
			const advice = await escalate(ctx, "The agent keeps repeating the same calls or the same failing command.");
			if (advice) entries.push(advice);
		}
		return entries.length > 0 ? { entries } : undefined;
	});

	// Compaction drops the task tool results from context; restore the contract as a message.
	pi.on("session_compact", (_event, ctx) => {
		// Compaction removed earlier results from context: reading them again is not a loop.
		run.loopGuard.forgetCalls();
		if (!on(ctx, "contract")) return;
		const contract = latestContract(branchMessages(ctx));
		if (!contract) return;
		pi.sendMessage(
			{ customType: CONTRACT_MESSAGE_TYPE, content: formatContract(contract), display: false, details: contract },
			{ deliverAs: "nextTurn" },
		);
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

	/**
	 * Run the checks for `changed` as a ladder: level by level, stopping at the first level
	 * with a failure. `inRun` limits it to cheap checks with shorter timeouts.
	 */
	async function runLadder(
		ctx: ExtensionContext,
		changed: readonly string[],
		maxLevel: 1 | 2 | 3,
		inRun: boolean,
	): Promise<{ outcomes: CheckOutcome[]; failed: CheckOutcome[] } | undefined> {
		const checks = activeChecks();
		if (checks.length === 0 || changed.length === 0) return undefined;
		if (controller.signal.aborted) controller = new AbortController();
		const outcomes: CheckOutcome[] = [];
		let tests: string[] | undefined;
		for (let level = 1; level <= maxLevel; level++) {
			const levelChecks = checks.filter((check) => (check.level ?? 1) === level);
			if (levelChecks.length === 0) continue;
			const selected: SelectedCheck[] = [];
			for (const item of selectChecks(levelChecks, changed)) {
				if (inRun && (checkDurations.get(item.check.name) ?? 0) > IN_RUN_CHECK_BUDGET_MS) continue;
				if (item.check.command.includes("{tests}")) {
					tests ??= testsFor(workspace(), changed);
					const argv = expandTests(item.check, tests);
					if (!argv) continue;
					selected.push({ ...item, argv });
				} else selected.push(item);
			}
			const levelOutcomes: CheckOutcome[] = [];
			for (const item of selected) {
				ctx.ui.setWorkingMessage(`Harness check: ${item.check.name}...`);
				const check = inRun
					? {
							...item,
							check: { ...item.check, timeoutMs: Math.min(item.check.timeoutMs, IN_RUN_CHECK_BUDGET_MS) },
						}
					: item;
				const outcome = await runCheck(check, ctx.cwd, controller.signal);
				checkDurations.set(item.check.name, outcome.elapsedMs);
				levelOutcomes.push(outcome);
			}
			ctx.ui.setWorkingMessage();
			if (controller.signal.aborted) return undefined;
			outcomes.push(...levelOutcomes);
			if (levelOutcomes.some((outcome) => !outcome.passed)) break;
		}
		return { outcomes, failed: outcomes.filter((outcome) => !outcome.passed) };
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
			const diff = await changeDiff(ctx, [...run.allChanged]);
			const advice = await requestAdvice(
				(context, signal) => ctx.modelRegistry.complete(model, context, { signal }),
				{
					request: run.prompt,
					diff,
					failure,
					attempt: run.lastAssistantText,
					relevantFiles: index ? [...run.allChanged] : [],
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

	/** Ask the decision backend and record a receipt. Undefined when unavailable: never approval. */
	async function askDecisions(
		version: string,
		state: unknown,
		questions: Parameters<DecisionBackend["ask"]>[1],
	): Promise<
		Awaited<ReturnType<DecisionBackend["ask"]>> extends infer R
			? (R extends { answers: infer A } ? A : never) | undefined
			: never
	> {
		if (!decisions) return undefined;
		const result = await decisions.ask(state, questions, controller.signal).catch(() => undefined);
		const answers = result?.answers;
		telemetry.record({
			type: "decision",
			version,
			backend: decisions.name,
			model: result?.model,
			digest: stateDigest(state, version),
			answers,
			latencyMs: result?.latencyMs,
			inputTokens: result?.inputTokens,
			available: result !== undefined,
		});
		return answers && Object.keys(answers).length > 0 ? answers : undefined;
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
					{
						context: 3,
					},
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
	 * baseline this includes shell edits and deletions; otherwise only edit/write changes.
	 */
	function driftInventory(ctx: ExtensionContext): FileChange[] {
		const inWorkspace = (path: string) => !path.startsWith(`${CONFIG_DIR_NAME}/`);
		if (run.baselineTree) {
			const root = gitRoot(ctx.cwd);
			const changes = root ? workingTreeChanges(ctx.cwd, run.baselineTree) : undefined;
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
	function backgroundNote(ctx: ExtensionContext): string {
		if (!on(ctx, "driftGuard")) return "";
		const signal = environmentSignals(run.shellCommands).find((item) => item.kind === "background_process");
		return signal ? `\nNote: ${signal.evidence}.` : "";
	}

	/** Test files as the request found them: the literals a special case would copy from. */
	function testSourcesAtStart(ctx: ExtensionContext, changes: readonly FileChange[]): Map<string, string> {
		const sources = new Map<string, string>();
		let bytes = 0;
		for (const change of changes) {
			if (isTestPath(change.path) && change.before !== undefined) sources.set(change.path, change.before);
		}
		for (const file of workspace().files) {
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

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!config.enabled || event.outcome !== "completed" || getMidnightStatus().agentMode === "plan") return;
		let changed = await changedFiles(ctx);
		// Ending again without changes does not fix a failure: check the same files again.
		if (changed.length === 0 && run.lastCheckFailed) changed = run.lastChecked;
		const result = await runLadder(ctx, changed, 3, false);
		if (result && result.outcomes.length > 0) {
			stats.checkRuns++;
			// Changes up to here are checked; later edits in a repair round re-trigger the checks.
			run.changed.clear();
			run.changedSinceInRun.clear();
			run.shellRan = false;
			run.startedAt = Date.now();
			const { outcomes, failed } = result;
			run.lastChecked = changed;
			run.lastCheckFailed = failed.length > 0;
			run.lastCheckSummary = formatCheckSummary(outcomes);
			telemetry.record({ type: "settle_check", passed: failed.length === 0, round: run.repairRound });
			if (failed.length === 0) {
				run.verifiedAt = Date.now();
				if (on(ctx, "checkpoints")) lastGreen = checkpointStore()?.snapshot("checks passed") ?? lastGreen;
			} else {
				stats.checkFailures++;
				// The sanctioned stop: after a repair round, a model that reports why the checks cannot
				// pass (a conflicting test, a missing dependency) is not pushed again. More rounds are the
				// pressure that turns an honest blocker into a special case or an undone request.
				if (
					on(ctx, "blockerExit") &&
					run.repairRound >= 1 &&
					disclosesDeviation(run.lastAssistantText) &&
					!claimsSuccess(run.lastAssistantText)
				) {
					stats.blockersAccepted++;
					telemetry.record({ type: "blocker_accepted", round: run.repairRound });
					return {
						entries: [
							{
								type: "custom_message",
								customType: CHECK_MESSAGE_TYPE,
								content: `Harness checks still fail, and the agent's last message says why; no further repair rounds.\n${run.lastCheckSummary}${backgroundNote(ctx)}`,
								display: true,
							},
						],
					};
				}
				if (run.repairRound >= config.maxRepairRounds) {
					return {
						entries: [
							{
								type: "custom_message",
								customType: CHECK_MESSAGE_TYPE,
								content: `Harness checks still fail after ${config.maxRepairRounds} repair round(s); stopping here. Tell the user what fails and why.\n${run.lastCheckSummary}${backgroundNote(ctx)}`,
								display: true,
							},
						],
					};
				}
				run.repairRound++;
				stats.repairs++;
				const key = failed
					.map((outcome) => outcome.name)
					.sort()
					.join("\0");
				const repeated = key === run.lastFailedKey;
				run.lastFailedKey = key;
				const feedback = formatCheckFeedback(
					outcomes,
					run.repairRound,
					config.maxRepairRounds,
					repeated,
					on(ctx, "blockerExit"),
				);
				const entries: SessionBoundaryDraft[] = [];
				let rollbackNote = "";
				if (repeated && on(ctx, "checkpoints") && lastGreen) {
					// Only files the agent edited in this prompt: others may hold the user's own work.
					const restored = checkpointStore()?.restore(
						lastGreen,
						[...run.allChanged].map((path) => resolve(ctx.cwd, path)),
					);
					if (restored && restored.paths.length > 0) {
						const paths = restored.paths.map((path) => workspaceRelative(ctx.cwd, path) ?? path);
						stats.rollbacks++;
						indexDirty = true;
						for (const path of paths) run.changed.add(path);
						telemetry.record({ type: "rollback", paths: paths.length });
						rollbackNote = [
							"",
							`The same checks failed twice, so the harness restored ${paths.join(", ")} to the last state in this request where the checks passed. This is the change it reverted; do not repeat it as is:`,
							"```diff",
							restored.diff.trimEnd(),
							"```",
						].join("\n");
					}
				}
				entries.push({
					type: "custom_message",
					customType: CHECK_MESSAGE_TYPE,
					content: `${feedback}${rollbackNote}`,
					display: true,
				});
				if (on(ctx, "escalation") && (repeated || run.repairRound >= 2)) {
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
		if (on(ctx, "driftGuard") && !run.lastCheckFailed) {
			const changes = driftInventory(ctx);
			if (changes.length > 0 || run.shellCommands.length > 0) {
				const signals = detectDrift({
					request: run.prompt,
					changes,
					finalMessage: run.lastAssistantText,
					verification: {
						verifiedAfterLastChange:
							run.verifiedAt !== undefined && run.verifiedAt >= (run.lastChangeAt ?? run.startedAt ?? 0),
						lastCheckFailed: run.lastCheckFailed,
					},
					testSources: testSourcesAtStart(ctx, changes),
					workspaceFiles: workspace()
						.files.map((file) => file.path)
						.filter((path) => !changes.some((change) => change.path === path && change.before === undefined)),
					shellCommands: run.shellCommands,
				});
				const flagged = actionable(signals);
				stats.driftChecks++;
				telemetry.record({
					type: run.driftNudged ? "drift_final" : "drift_check",
					kinds: signals.map((signal) => signal.kind),
					actionable: flagged.length,
					disclosed: disclosesDeviation(run.lastAssistantText),
				});
				if (flagged.length > 0 && !run.driftNudged) {
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
			}
		}

		// An independent review, once per prompt, when the checks pass or there are none: the model
		// that wrote the change is not the one that judges whether it is done.
		if (decisions && on(ctx, "decisions") && !run.reviewed && run.allChanged.size > 0 && !run.lastCheckFailed) {
			run.reviewed = true;
			const state = compactReviewState({
				request: run.prompt,
				final_message: run.lastAssistantText ?? "",
				change: {
					files: [...run.allChanged],
					checks: run.lastCheckSummary ?? "No project checks are configured or detected; nothing was run.",
					diff: await changeDiff(ctx, [...run.allChanged]),
				},
			});
			const answers = await askDecisions(REVIEW_VERSION, state, REVIEW_QUESTIONS);
			if (answers) {
				stats.reviews++;
				const verdict = reviewPolicy(answers);
				telemetry.record({ type: "review", action: verdict.action, probabilities: verdict.probabilities });
				if (verdict.action === "revise") {
					stats.revisions++;
					return {
						entries: [
							{
								type: "custom_message",
								customType: REVIEW_MESSAGE_TYPE,
								content: formatReviewFeedback(verdict, decisions.name),
								display: true,
							},
						],
						continue: true,
					};
				}
			}
		}

		if (!on(ctx, "contract") || run.contractNudged) return;
		const contract = latestContract(branchMessages(ctx));
		if (!contract || openCriteria(contract).length === 0) return;
		run.contractNudged = true;
		stats.contractNudges++;
		const entry: SessionBoundaryDraft = {
			type: "custom_message",
			customType: CONTRACT_MESSAGE_TYPE,
			content: contractReminder(contract, run.lastCheckSummary),
			display: true,
		};
		return { entries: [entry], continue: true };
	});

	pi.registerCommand("harness", {
		description: "Show the harness state: model class, features, checks, context pack, escalation and savings",
		handler: async (_args, ctx) => {
			if (!config.enabled) {
				ctx.ui.notify("Harness is off (MIDNIGHT_SERVER_HARNESS=0 or enabled: false in harness.json).");
				return;
			}
			const contract = latestContract(branchMessages(ctx));
			const resolved = features(ctx);
			const checks = activeChecks();
			const lines = [
				`Harness config: ${harnessConfigPath(ctx.cwd)}${ctx.isProjectTrusted() ? "" : " (project not trusted: project checks, detected checks and language servers are off)"}`,
				`Model class: ${modelClass(ctx)} (${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model"})`,
				`Features on: ${Object.entries(resolved)
					.filter(([, enabled]) => enabled)
					.map(([name]) => name)
					.join(", ")}`,
				`Checks: ${checks.length > 0 ? checks.map((check) => `${check.name} (level ${check.level ?? 1}${"source" in check ? `, from ${check.source}` : ""})`).join(", ") : "none configured or detected"}`,
				`Protected: ${["harness.json", ...config.protect].join(", ")}`,
				`Check runs: ${stats.checkRuns} (${stats.checkFailures} failed, ${stats.repairs} repair rounds, ${stats.rollbacks} rollbacks); contract reminders: ${stats.contractNudges}`,
				`Drift: ${stats.driftChecks} check(s), ${stats.driftNudges} fix-or-disclose request(s), ${stats.blockersAccepted} reported blocker(s) accepted`,
				`Context packs: ${stats.packs} (${(stats.packBytes / 1024).toFixed(1)} KB)`,
				`Context masking: ${stats.maskBatches} batch(es), ${(stats.elidedBytes / 1024).toFixed(1)} KB elided (~${Math.round(stats.elidedBytes / 4)} tokens per later request)`,
				`Escalation: ${config.escalation.model}, ${stats.escalations} call(s), $${stats.escalationCostUsd.toFixed(4)}`,
				`Decisions: ${decisions ? `${decisions.name}, ${stats.reviews} review(s), ${stats.revisions} revision request(s)` : 'off (install Laya with pip install "laya[serve]", or set MIDNIGHT_SERVER_LAYA_URL to a local laya-serve)'}`,
				`Language servers: ${lsp?.running.join(", ") || "none running"}`,
				`Events: ${telemetry.summary()}`,
			];
			if (contract) lines.push("", formatContract(contract));
			ctx.ui.notify(lines.join("\n"));
		},
	});
}

function gitSummary(cwd: string): { branch?: string; changed: string[] } | undefined {
	const status = spawnSync("git", ["status", "--porcelain=v1", "-z", "--branch"], {
		cwd,
		encoding: "utf8",
		windowsHide: true,
		timeout: 10_000,
	});
	if (status.status !== 0 || typeof status.stdout !== "string") return undefined;
	const [header, ...rest] = status.stdout.split("\0");
	const branch = /^## (?:No commits yet on )?([^.\s]+)/.exec(header ?? "")?.[1];
	// The harness's own config directory is not a change the model should look at.
	const changed = parsePorcelainZ(rest.join("\0")).filter((path) => !path.startsWith(`${CONFIG_DIR_NAME}/`));
	return { branch, changed };
}
