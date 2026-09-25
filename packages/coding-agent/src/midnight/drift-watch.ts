import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Box, Text } from "@earendil-works/pi-tui";
import { estimateContextTokens } from "../core/compaction/compaction.ts";
import { serializeConversation } from "../core/compaction/utils.ts";
import type { ExtensionAPI, ExtensionFactory } from "../core/extensions/types.ts";
import { convertToLlm } from "../core/messages.ts";
import type { ChatRequest, ChatResult } from "./engine.ts";
import { type EngineManager, LocalSetupError } from "./engine-manager.ts";
import { type DriftWatchState, updateMidnightStatus } from "./status.ts";

/** Minimal engine surface this module needs; mirrors helper.ts's HelperEngine. */
interface DriftEngine {
	chat(request: ChatRequest): Promise<ChatResult>;
}

export interface DriftWatchSettings {
	enabled: boolean;
	/** Run a check after this many assistant turns since the last one. */
	turnInterval: number;
	/** Run a check once context has grown by this many tokens since the last one. */
	tokenInterval: number;
	/** Suppress a new visible nudge until this many turns have passed since the last one fired. */
	cooldownTurns: number;
}

function positiveIntegerEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
	return value;
}

function booleanEnv(name: string): boolean | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	if (raw === "0" || raw.toLowerCase() === "false") return false;
	if (raw === "1" || raw.toLowerCase() === "true") return true;
	throw new Error(`${name} must be "0", "1", "true" or "false"`);
}

export function resolveDriftWatchSettings(overrides: Partial<DriftWatchSettings> = {}): DriftWatchSettings {
	return {
		enabled: overrides.enabled ?? booleanEnv("MIDNIGHT_SERVER_DRIFTWATCH") ?? true,
		turnInterval: overrides.turnInterval ?? positiveIntegerEnv("MIDNIGHT_SERVER_DRIFTWATCH_TURNS") ?? 6,
		tokenInterval: overrides.tokenInterval ?? positiveIntegerEnv("MIDNIGHT_SERVER_DRIFTWATCH_TOKENS") ?? 4000,
		cooldownTurns: overrides.cooldownTurns ?? positiveIntegerEnv("MIDNIGHT_SERVER_DRIFTWATCH_COOLDOWN") ?? 4,
	};
}

const DRIFT_STATUSES = ["on_track", "drifting", "off_task"] as const;
type DriftStatus = (typeof DRIFT_STATUSES)[number];

interface DriftVerdict {
	status: DriftStatus;
	reason: string;
	reminder?: string;
}

const DRIFT_SCHEMA = {
	type: "object",
	properties: {
		status: { type: "string", enum: DRIFT_STATUSES },
		reason: { type: "string" },
		reminder: { type: "string" },
	},
	required: ["status", "reason"],
} as const;

function parseVerdict(content: string): DriftVerdict {
	const value: unknown = JSON.parse(content);
	if (typeof value !== "object" || value === null) throw new Error("not an object");
	const record = value as Record<string, unknown>;
	if (!DRIFT_STATUSES.includes(record.status as DriftStatus)) throw new Error("invalid status");
	if (typeof record.reason !== "string" || !record.reason.trim()) throw new Error("missing reason");
	const reminder = typeof record.reminder === "string" && record.reminder.trim() ? record.reminder.trim() : undefined;
	return { status: record.status as DriftStatus, reason: record.reason.trim(), reminder };
}

const MAX_INPUT_BYTES = 10_000;
const HEAD_BYTES = 1_500;

/** Keep the earliest slice (the goal) and the latest slice (recent activity), dropping the middle. */
function boundTranscript(text: string, maxBytes = MAX_INPUT_BYTES, headBytes = HEAD_BYTES): string {
	const full = Buffer.from(text, "utf8");
	if (full.length <= maxBytes) return text;
	const head = full.subarray(0, headBytes).toString("utf8");
	const tail = full.subarray(full.length - (maxBytes - headBytes)).toString("utf8");
	return `${head}\n\n[...omitted for length...]\n\n${tail}`;
}

const DRIFT_SYSTEM_PROMPT = [
	"You are midnight.server's local focus checker for a coding assistant.",
	"You have no tools and cannot edit anything. You only judge whether the assistant in the transcript below is still working its stated goal.",
	"status=on_track: the assistant is still working the goal, even via a reasonable subtask.",
	"status=drifting: the assistant is nominally still working but has lost an explicit constraint, contradicted an earlier decision, or wandered without saying so.",
	"status=off_task: the assistant is doing something unrelated to the stated goal.",
	"When status is not on_track, reminder must be one or two sentences naming the specific constraint or goal being missed, for the assistant to read next.",
	"Respond with one JSON object matching the required schema.",
].join("\n");

/**
 * Judge whether the parent model's recent turns still serve the conversation's
 * original goal. Bounded, read-only, no tools: same trust model as the helper.
 */
async function runDriftCheck(
	engine: DriftEngine,
	transcript: string,
	signal: AbortSignal,
): Promise<DriftVerdict | undefined> {
	const messages = [
		{ role: "system" as const, content: DRIFT_SYSTEM_PROMPT },
		{
			role: "user" as const,
			content: `<transcript>\n${boundTranscript(transcript)}\n</transcript>\n\nJudge whether the assistant above is still on track.`,
		},
	];
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = await engine.chat({
			messages:
				attempt === 0
					? messages
					: [
							...messages,
							{
								role: "user" as const,
								content: "Your previous answer was invalid JSON. Reply again with only the JSON object.",
							},
						],
			maxTokens: 400,
			enableThinking: false,
			jsonSchema: DRIFT_SCHEMA,
			signal,
		});
		if (result.finishReason === "length") continue;
		try {
			return parseVerdict(result.content);
		} catch {
			// retry once
		}
	}
	return undefined;
}

/**
 * Periodically ask the local MiniCPM engine whether the parent model (in `--hybrid`
 * sessions) is still on track, and inject a corrective reminder only when it isn't.
 * Runs in the background: a `turn_end` handler that awaited the check directly would
 * block the agent loop for the duration of a CPU inference call (10-30s, see
 * docs/benchmarks/cpu-i7-8650u.md).
 */
export function createDriftWatchExtension(manager: EngineManager, settings: DriftWatchSettings): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		if (!settings.enabled) return;

		let latestMessages: AgentMessage[] = [];
		let turnsSinceCheck = 0;
		let tokensAtLastCheck = 0;
		let turnsSinceNudge = settings.cooldownTurns;
		let checking = false;
		let unavailable = false;
		let controller: AbortController | undefined;
		let lastVerdict: DriftWatchState["lastVerdict"];
		const publish = () =>
			updateMidnightStatus({
				drift: unavailable
					? undefined
					: {
							checking,
							lastVerdict,
							turnsUntilCheck: Math.max(0, settings.turnInterval - turnsSinceCheck),
						},
			});
		publish();

		pi.registerMessageRenderer("midnight_drift_watch", (message, { outputPad }, theme) => {
			const details = message.details as DriftVerdict | undefined;
			const label = details?.status === "off_task" ? "off task" : "drifting";
			const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
			box.addChild(
				new Text(`${theme.fg("warning", `[local focus check: ${label}]`)} ${details?.reason ?? ""}`, 0, 0),
			);
			return box;
		});

		pi.on("context", (event) => {
			latestMessages = event.messages;
		});

		pi.on("session_shutdown", () => {
			controller?.abort();
		});

		pi.on("turn_end", (_event, ctx) => {
			if (unavailable || checking) return;
			turnsSinceCheck++;
			turnsSinceNudge++;
			const currentTokens = estimateContextTokens(latestMessages).tokens;
			const dueByTurns = turnsSinceCheck >= settings.turnInterval;
			const dueByTokens = currentTokens - tokensAtLastCheck >= settings.tokenInterval;
			if (!dueByTurns && !dueByTokens) {
				publish();
				return;
			}
			turnsSinceCheck = 0;
			tokensAtLastCheck = currentTokens;

			const transcript = serializeConversation(convertToLlm(latestMessages));
			checking = true;
			publish();
			controller = new AbortController();
			const signal = controller.signal;
			void (async () => {
				try {
					const engine = await manager.get(signal);
					manager.touch();
					const verdict = await runDriftCheck(engine, transcript, signal);
					lastVerdict = verdict?.status ?? lastVerdict;
					if (!verdict || verdict.status === "on_track") return;
					if (turnsSinceNudge < settings.cooldownTurns) return;
					turnsSinceNudge = 0;
					const reminder = verdict.reminder ?? verdict.reason;
					pi.sendMessage(
						{
							customType: "midnight_drift_watch",
							content: [
								{
									type: "text",
									text: `Local focus check (${verdict.status}): ${verdict.reason}\n\nReminder: ${reminder}`,
								},
							],
							display: true,
							details: verdict,
						},
						{ deliverAs: "nextTurn" },
					);
				} catch (error) {
					if (error instanceof LocalSetupError) unavailable = true;
					else
						ctx.ui.notify(
							`Local focus check failed: ${error instanceof Error ? error.message : String(error)}`,
							"warning",
						);
				} finally {
					checking = false;
					publish();
				}
			})();
		});
	};
}
