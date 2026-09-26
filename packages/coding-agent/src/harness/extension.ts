import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Box, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageRenderer,
	SessionBoundaryDraft,
} from "../core/extensions/types.ts";
import { LOCAL_PROVIDER_ID } from "../midnight/pins.ts";
import { getMidnightStatus } from "../midnight/status.ts";
import {
	type CheckOutcome,
	filesModifiedSince,
	formatCheckFeedback,
	formatCheckSummary,
	matchesAny,
	parsePorcelainZ,
	runCheck,
	selectChecks,
	workspaceRelative,
} from "./checks.ts";
import {
	defaultHarnessConfig,
	type HarnessConfig,
	HarnessConfigError,
	harnessConfigPath,
	loadHarnessConfig,
} from "./config.ts";
import {
	createContract,
	formatContract,
	latestContract,
	openCriteria,
	TASK_TOOL_NAME,
	type TaskContract,
	updateContract,
} from "./contract.ts";
import { remapForeignPath, repairPowerShellCommand, toolNeedsExistingPath } from "./interface-repair.ts";
import { capToolOutput, LOCAL_TOOLS, splitContextFiles, withGreedyDefault } from "./local-profile.ts";
import { planMasking } from "./masking.ts";

export const CHECK_MESSAGE_TYPE = "harness_check";
export const CONTRACT_MESSAGE_TYPE = "harness_contract";

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

function branchMessages(ctx: ExtensionContext): AgentMessage[] {
	return ctx.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

function isLocalModel(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === LOCAL_PROVIDER_ID;
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

interface RunState {
	startedAt?: number;
	changed: Set<string>;
	shellRan: boolean;
	repairRound: number;
	lastFailedKey?: string;
	contractNudged: boolean;
	lastCheckSummary?: string;
}

function freshRun(): RunState {
	return { changed: new Set(), shellRan: false, repairRound: 0, contractNudged: false };
}

/**
 * The harness: grounded verification before a run may settle, a task contract that holds the
 * run to checkable acceptance criteria, protected files the agent cannot edit, batched
 * observation masking, and a local-model profile. Model-agnostic: it improves any session
 * model, and it adds no model calls of its own. See docs/harness.md.
 */
export default function harnessExtension(pi: ExtensionAPI): void {
	let config: HarnessConfig = defaultHarnessConfig();
	let run = freshRun();
	let controller = new AbortController();
	const stats = { maskBatches: 0, elidedBytes: 0, checkRuns: 0, checkFailures: 0, repairs: 0, contractNudges: 0 };

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

	pi.on("session_start", (_event, ctx) => {
		try {
			config = loadHarnessConfig(ctx.cwd, ctx.isProjectTrusted());
		} catch (error) {
			config = defaultHarnessConfig();
			if (error instanceof HarnessConfigError) ctx.ui.notify(`Harness config ignored: ${error.message}`, "warning");
			else throw error;
		}
		if (!config.enabled || !config.contract) {
			pi.setActiveTools(pi.getActiveTools().filter((name) => name !== TASK_TOOL_NAME));
		}
	});

	pi.on("session_shutdown", () => {
		controller.abort();
	});

	pi.on("agent_start", () => {
		run.startedAt ??= Date.now();
	});

	pi.on("agent_settled", () => {
		run = freshRun();
	});

	// Protected files: the project's own checks and anything the user listed. A model that can
	// edit the checks it is graded by can pass them without doing the work.
	// Argument repairs made in tool_call, reported to the model with the tool's result.
	const repairNotes = new Map<string, string>();
	pi.on("tool_call", (event, ctx) => {
		if (!config.enabled) return;
		const input = event.input as { path?: unknown; command?: unknown; timeout?: unknown };
		if (
			(event.toolName === "bash" || event.toolName === "powershell") &&
			input.timeout === undefined &&
			config.shellTimeoutSeconds > 0
		) {
			input.timeout = config.shellTimeoutSeconds;
		}
		if (event.toolName === "powershell" && typeof input.command === "string") {
			const repaired = repairPowerShellCommand(input.command);
			if (repaired) {
				input.command = repaired;
				repairNotes.set(event.toolCallId, "[harness: rewrote /dev/null redirects as $null for PowerShell]");
			}
		}
		if (typeof input.path === "string") {
			const remapped = remapForeignPath(ctx.cwd, input.path, toolNeedsExistingPath(event.toolName));
			if (remapped) {
				repairNotes.set(
					event.toolCallId,
					`[harness: ${input.path} does not exist on this machine; used ${remapped} in the workspace (${ctx.cwd}). Use workspace-relative paths.]`,
				);
				input.path = remapped;
			}
		}
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const path = input.path;
		if (typeof path !== "string") return;
		const rel = workspaceRelative(ctx.cwd, path);
		if (!rel) return;
		const configRel = workspaceRelative(ctx.cwd, harnessConfigPath(ctx.cwd));
		if (rel !== configRel && !matchesAny(rel, config.protect)) return;
		return {
			block: true,
			reason: `${rel} is protected by the harness: the user owns it and the agent may not change it. Change the code under test instead, or ask the user to change this file.`,
		};
	});

	pi.on("tool_result", (event, ctx) => {
		if (!config.enabled) return;
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
			const path = event.input.path;
			const rel = typeof path === "string" ? workspaceRelative(ctx.cwd, path) : undefined;
			if (rel) run.changed.add(rel);
		}
		if (event.toolName === "bash" || event.toolName === "powershell") run.shellRan = true;
		const note = repairNotes.get(event.toolCallId);
		repairNotes.delete(event.toolCallId);
		const capped =
			config.localProfile && isLocalModel(ctx) && event.toolName !== TASK_TOOL_NAME
				? capToolOutput(event.content, event.toolName)
				: undefined;
		if (!note && !capped) return;
		const content = capped ?? event.content;
		return { content: note ? [{ type: "text", text: note }, ...content] : content };
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!config.enabled || !config.localProfile || !isLocalModel(ctx)) return;
		return withGreedyDefault(event.payload);
	});

	// Tools the local profile hid, restored as soon as a different model drives the session.
	let hiddenTools: string[] = [];
	pi.on("before_agent_start", (event, ctx) => {
		if (!config.enabled || !config.localProfile || !isLocalModel(ctx)) {
			if (hiddenTools.length > 0) {
				pi.setActiveTools([...new Set([...pi.getActiveTools(), ...hiddenTools])]);
				hiddenTools = [];
			}
			delete event.systemPromptOptions.sections.project_files;
			return;
		}
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
	});

	pi.on("turn_end", (event) => {
		if (!config.enabled) return;
		const plan = planMasking(event.context.contextEntries, config.masking);
		if (plan.edits.length === 0) return;
		stats.maskBatches++;
		stats.elidedBytes += plan.elidedBytes;
		return { entries: plan.edits };
	});

	// Compaction drops the task tool results from context; restore the contract as a message.
	pi.on("session_compact", (_event, ctx) => {
		if (!config.enabled || !config.contract) return;
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

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!config.enabled || event.outcome !== "completed" || getMidnightStatus().agentMode === "plan") return;
		if (controller.signal.aborted) controller = new AbortController();

		const selected = selectChecks(config.checks, await changedFiles(ctx));
		if (selected.length > 0) {
			const outcomes: CheckOutcome[] = [];
			for (const item of selected) {
				ctx.ui.setWorkingMessage(`Harness check: ${item.check.name}...`);
				outcomes.push(await runCheck(item, ctx.cwd, controller.signal));
			}
			ctx.ui.setWorkingMessage();
			if (controller.signal.aborted) return;
			stats.checkRuns++;
			// Changes up to here are checked; later edits in a repair round re-trigger the checks.
			run.changed.clear();
			run.shellRan = false;
			run.startedAt = Date.now();
			const failed = outcomes.filter((outcome) => !outcome.passed);
			run.lastCheckSummary = formatCheckSummary(outcomes);
			if (failed.length > 0) {
				stats.checkFailures++;
				if (run.repairRound >= config.maxRepairRounds) {
					return {
						entries: [
							{
								type: "custom_message",
								customType: CHECK_MESSAGE_TYPE,
								content: `Harness checks still fail after ${config.maxRepairRounds} repair round(s); stopping here. Tell the user what fails and why.\n${run.lastCheckSummary}`,
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
				return {
					entries: [
						{
							type: "custom_message",
							customType: CHECK_MESSAGE_TYPE,
							content: formatCheckFeedback(outcomes, run.repairRound, config.maxRepairRounds, repeated),
							display: true,
						},
					],
					continue: true,
				};
			}
		}

		if (!config.contract || run.contractNudged) return;
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
		description: "Show the harness state: checks, protected files, the task contract and context savings",
		handler: async (_args, ctx) => {
			if (!config.enabled) {
				ctx.ui.notify("Harness is off (MIDNIGHT_SERVER_HARNESS=0 or enabled: false in harness.json).");
				return;
			}
			const contract = latestContract(branchMessages(ctx));
			const lines = [
				`Harness config: ${harnessConfigPath(ctx.cwd)}${ctx.isProjectTrusted() ? "" : " (project not trusted: checks from it are not loaded)"}`,
				`Checks: ${config.checks.length > 0 ? config.checks.map((check) => check.name).join(", ") : "none configured"}`,
				`Protected: ${["harness.json", ...config.protect].join(", ")}`,
				`Check runs: ${stats.checkRuns} (${stats.checkFailures} failed, ${stats.repairs} repair rounds); contract reminders: ${stats.contractNudges}`,
				`Context masking: ${config.masking.enabled ? `${stats.maskBatches} batch(es), ${(stats.elidedBytes / 1024).toFixed(1)} KB elided (~${Math.round(stats.elidedBytes / 4)} tokens per later request)` : "off"}`,
				`Local profile: ${config.localProfile ? (isLocalModel(ctx) ? "active" : "on (inactive for this model)") : "off"}`,
			];
			if (contract) lines.push("", formatContract(contract));
			ctx.ui.notify(lines.join("\n"));
		},
	});
}
