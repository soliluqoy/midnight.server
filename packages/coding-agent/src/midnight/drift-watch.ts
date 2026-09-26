import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Box, Text } from "@earendil-works/pi-tui";
import { estimateContextTokens } from "../core/compaction/compaction.ts";
import { serializeConversation } from "../core/compaction/utils.ts";
import type { ExtensionAPI, ExtensionFactory } from "../core/extensions/types.ts";
import { convertToLlm } from "../core/messages.ts";
import { latestAnchor, sideThreadStoreFor } from "../core/side-threads.ts";
import type { ChatRequest, ChatResult, TokenLogprob } from "./engine.ts";
import { type EngineManager, LocalSetupError, LocalStoppedError } from "./engine-manager.ts";
import { LOCAL_MODEL_ID, LOCAL_PROVIDER_ID } from "./pins.ts";
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
	/** Suppress a new finding until this many turns have passed since the last one. */
	cooldownTurns: number;
	/** Report only when the decision gate puts at least this probability (0-1) on not being on track. */
	nudgeConfidence: number;
}

function positiveIntegerEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
	return value;
}

function unitIntervalEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be a number from 0 to 1`);
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
		nudgeConfidence: overrides.nudgeConfidence ?? unitIntervalEnv("MIDNIGHT_SERVER_DRIFTWATCH_CONFIDENCE") ?? 0.5,
	};
}

export const DRIFT_STATUSES = ["on_track", "drifting", "off_task"] as const;
type DriftStatus = (typeof DRIFT_STATUSES)[number];

type DriftProbabilities = Record<DriftStatus, number>;

export interface DriftVerdict {
	status: DriftStatus;
	reason: string;
	reminder?: string;
	/** Decision-gate probabilities; absent when the check fell back to a single explain call. */
	confidence?: DriftProbabilities;
}

/** Tag shown on drift findings, e.g. `[check: off task]`. */
function checkTag(status: DriftStatus): string {
	return `[check: ${status.replace("_", " ")}]`;
}

/** Verdict schema; `statuses` narrows the enum when the gate has already decided. */
function verdictSchema(statuses: readonly DriftStatus[]): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			status: { type: "string", enum: statuses },
			reason: { type: "string" },
			reminder: { type: "string" },
		},
		required: ["status", "reason"],
	};
}

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

// The system prompt and transcript form a prefix shared by the gate and the explain
// call, so llama-server's single slot reuses its cache and the explain call only
// pays for the question that differs.
const DRIFT_SYSTEM_PROMPT = [
	"You are midnight.server's local focus checker for a coding assistant.",
	"You have no tools and cannot edit anything. You only judge whether the assistant in the transcript below is still working its stated goal.",
	"status=on_track: the assistant is still working the goal, even via a reasonable subtask.",
	"status=drifting: the assistant is nominally still working but has lost an explicit constraint, contradicted an earlier decision, or wandered without saying so.",
	"status=off_task: the assistant is doing something unrelated to the stated goal.",
].join("\n");

const REMINDER_RULE =
	"When status is not on_track, reminder must be one or two sentences naming the specific constraint or goal being missed, for the assistant to read next.";

const GATE_QUESTION = `Judge whether the assistant above is still on track. Answer with only the status: ${DRIFT_STATUSES.join(", ")}.`;

const GATE_GRAMMAR = `root ::= ${DRIFT_STATUSES.map((status) => JSON.stringify(status)).join(" | ")}`;

/** Alternatives requested for the gate token; the three labels sit well inside this. */
const GATE_TOP_LOGPROBS = 20;

function driftMessages(transcript: string, question: string): ChatRequest["messages"] {
	return [
		{ role: "system", content: DRIFT_SYSTEM_PROMPT },
		{ role: "user", content: `<transcript>\n${boundTranscript(transcript)}\n</transcript>\n\n${question}` },
	];
}

/**
 * Turn the gate's first-token alternatives into a distribution over the statuses.
 * Each label starts with a distinct token, so a token that prefixes exactly one
 * label carries that label's mass; the rest (text the grammar forbids) is dropped
 * and the remainder renormalized.
 */
export function gateProbabilities(top: TokenLogprob["top"]): DriftProbabilities | undefined {
	const mass: DriftProbabilities = { on_track: 0, drifting: 0, off_task: 0 };
	for (const alternative of top) {
		if (!alternative.token) continue;
		const matches = DRIFT_STATUSES.filter((status) => status.startsWith(alternative.token));
		if (matches.length === 1) mass[matches[0]] += Math.exp(alternative.logprob);
	}
	const total = mass.on_track + mass.drifting + mass.off_task;
	if (!(total > 0)) return undefined;
	return { on_track: mass.on_track / total, drifting: mass.drifting / total, off_task: mass.off_task / total };
}

/**
 * System-1 decision: one grammar-constrained status token, read as probabilities.
 * Returns undefined when the engine gave no usable logprobs.
 */
export async function runDriftGate(
	engine: DriftEngine,
	transcript: string,
	signal: AbortSignal,
): Promise<DriftProbabilities | undefined> {
	const result = await engine.chat({
		messages: driftMessages(transcript, GATE_QUESTION),
		maxTokens: 8,
		temperature: 0,
		enableThinking: false,
		grammar: GATE_GRAMMAR,
		topLogprobs: GATE_TOP_LOGPROBS,
		signal,
	});
	const first = result.logprobs?.[0];
	return first ? gateProbabilities(first.top) : undefined;
}

/**
 * Written verdict. With `status` the gate has decided and this only explains it;
 * without, it is the whole check (fallback when the gate is unavailable).
 * Bounded, read-only, no tools: same trust model as the helper.
 */
async function runDriftCheck(
	engine: DriftEngine,
	transcript: string,
	signal: AbortSignal,
	status?: DriftStatus,
): Promise<DriftVerdict | undefined> {
	const question = [
		status
			? `A first check found status=${status}. Explain why.`
			: "Judge whether the assistant above is still on track.",
		REMINDER_RULE,
		"Respond with one JSON object matching the required schema.",
	].join(" ");
	const messages = driftMessages(transcript, question);
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
			jsonSchema: verdictSchema(status ? [status] : DRIFT_STATUSES),
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
 * Judge drift in two stages: a cheap gate decides, and only a confident "not on
 * track" pays for the written explanation. The gate is authoritative: measured on
 * the real model, the explain call at sampling temperature can call a clearly
 * on-track transcript off task.
 */
async function judgeDrift(
	engine: DriftEngine,
	transcript: string,
	nudgeConfidence: number,
	signal: AbortSignal,
): Promise<DriftVerdict | undefined> {
	let probabilities: DriftProbabilities | undefined;
	try {
		probabilities = await runDriftGate(engine, transcript, signal);
	} catch (error) {
		if (signal.aborted) throw error;
	}
	if (!probabilities) return runDriftCheck(engine, transcript, signal);
	if (1 - probabilities.on_track < nudgeConfidence) {
		return { status: "on_track", reason: "", confidence: probabilities };
	}
	const status: DriftStatus = probabilities.drifting >= probabilities.off_task ? "drifting" : "off_task";
	const explained = await runDriftCheck(engine, transcript, signal, status);
	const percent = Math.round((1 - probabilities.on_track) * 100);
	return {
		status,
		reason: explained?.reason ?? `The local check is ${percent}% confident the assistant is not on track.`,
		reminder: explained?.reminder,
		confidence: probabilities,
	};
}

/** The question a drift finding answers in its side thread. */
export const DRIFT_QUESTION = "Drift check: is the agent still on track?";

/** Side-thread answer for a finding; `m` sends it to the agent as the reminder. */
export function driftAnswer(verdict: DriftVerdict): string {
	const reminder = verdict.reminder ?? verdict.reason;
	const confidence = verdict.confidence
		? ` (${Math.round((1 - verdict.confidence.on_track) * 100)}% not on track)`
		: "";
	return `${checkTag(verdict.status)}${confidence} ${verdict.reason}\n\nReminder: ${reminder}`;
}

/**
 * Periodically ask the local MiniCPM engine whether the parent model (in `--hybrid`
 * sessions) is still on track. When it isn't, the finding is added as a side thread on
 * the newest transcript item; the agent sees it only if the user sends it (`m`) or
 * branches from it (`b`), so a false positive from the 2B checker never steers the agent.
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
		let turnsSinceFinding = settings.cooldownTurns;
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

		// Sessions from before findings became side threads contain these messages.
		pi.registerMessageRenderer("midnight_drift_watch", (message, { outputPad }, theme) => {
			const details = message.details as DriftVerdict | undefined;
			const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
			box.addChild(
				new Text(`${theme.fg("warning", checkTag(details?.status ?? "drifting"))} ${details?.reason ?? ""}`, 0, 0),
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
			// The local model selected with /model is the parent; there is no separate model to watch.
			// Stopped with /local-stop: skip checks, and do not count turns toward one.
			if (unavailable || checking || manager.isDisabled || ctx.model?.provider === LOCAL_PROVIDER_ID) return;
			turnsSinceCheck++;
			turnsSinceFinding++;
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
			// Resolved now: by the time the check finishes the agent may have moved on.
			const anchor = latestAnchor(
				ctx.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
			);
			const store = sideThreadStoreFor(ctx.sessionManager);
			const startedAt = Date.now();
			checking = true;
			publish();
			controller = new AbortController();
			const signal = controller.signal;
			void (async () => {
				try {
					const engine = await manager.get(signal);
					manager.touch();
					const verdict = await judgeDrift(engine, transcript, settings.nudgeConfidence, signal);
					lastVerdict = verdict?.status ?? lastVerdict;
					if (!verdict || verdict.status === "on_track" || !anchor) return;
					if (turnsSinceFinding < settings.cooldownTurns) return;
					turnsSinceFinding = 0;
					store.appendTurn(anchor, {
						question: DRIFT_QUESTION,
						answer: driftAnswer(verdict),
						model: { provider: LOCAL_PROVIDER_ID, id: LOCAL_MODEL_ID, kind: "local" },
						status: "done",
						startedAt,
						finishedAt: Date.now(),
						origin: "drift",
					});
				} catch (error) {
					// Aborted by session_shutdown: ctx is stale by then, and touching it throws
					// from this detached task, which crashes the process.
					// Stopped with /local-stop mid-check: the engine was killed under the request.
					if (signal.aborted || error instanceof LocalStoppedError || manager.isDisabled) return;
					if (error instanceof LocalSetupError) unavailable = true;
					else
						ctx.ui.notify(`[check] failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
				} finally {
					checking = false;
					publish();
				}
			})();
		});
	};
}
