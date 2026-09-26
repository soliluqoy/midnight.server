/**
 * Side threads: short questions about one transcript item, answered by any model
 * without entering the main agent's context. Threads are stored beside the session
 * file (`<session>.threads.json`) so the session tree, forks, and compaction are
 * unaffected.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ModelsSimpleStreamOptions,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { SessionModelRequest } from "./agent-session.ts";
import type { ModelRuntime } from "./model-runtime.ts";

/** How a turn chose its model; this decides how much context the request carries. */
export type SideThreadModelKind = "local" | "same" | "other";

export interface SideThreadModelRef {
	provider: string;
	id: string;
	kind: SideThreadModelKind;
}

export type SideThreadTurnStatus = "running" | "done" | "error" | "aborted";

export interface SideThreadTurn {
	question: string;
	answer: string;
	model: SideThreadModelRef;
	status: SideThreadTurnStatus;
	error?: string;
	startedAt: number;
	finishedAt?: number;
}

export interface SideThread {
	/** Stable id of the transcript item: `tool:<toolCallId>` or `assistant:<timestamp>`. */
	anchorId: string;
	/** One-line description of the item, e.g. `bash npm run check`. */
	anchorLabel: string;
	/** Text of the item captured when the thread started, so answers survive restarts. */
	excerpt: string;
	turns: SideThreadTurn[];
	/** Number of turns already sent to the main agent. */
	sentTurns: number;
	createdAt: number;
}

interface SideThreadFile {
	version: 1;
	threads: SideThread[];
}

/** Largest excerpt sent to cloud models; the local model gets LOCAL_EXCERPT_BYTES. */
export const MAX_EXCERPT_CHARS = 24_000;
/** Matches the delegate_local byte budget: a 2B model answers well only on small inputs. */
export const LOCAL_EXCERPT_CHARS = 6_000;
const RECENT_TRANSCRIPT_CHARS = 12_000;
const LOCAL_MAX_TOKENS = 1024;
const OTHER_MAX_TOKENS = 4096;

export function sideThreadFileFor(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	return sessionFile.endsWith(".jsonl") ? `${sessionFile.slice(0, -6)}.threads.json` : `${sessionFile}.threads.json`;
}

/** Remove a session's thread file. Used when the session file itself is deleted. */
export function deleteSideThreadFile(sessionFile: string): void {
	const file = sideThreadFileFor(sessionFile);
	if (file) rmSync(file, { force: true });
}

/**
 * Threads for one session. With no file (in-memory sessions) threads live only in memory.
 * Running turns are saved as aborted: a restart cannot resume their stream.
 */
export class SideThreadStore {
	readonly file: string | undefined;
	private threads = new Map<string, SideThread>();

	constructor(file: string | undefined) {
		this.file = file;
		this.load();
	}

	private load(): void {
		if (!this.file || !existsSync(this.file)) return;
		try {
			const data = JSON.parse(readFileSync(this.file, "utf8")) as Partial<SideThreadFile>;
			if (data.version !== 1 || !Array.isArray(data.threads)) return;
			for (const thread of data.threads) {
				if (typeof thread?.anchorId !== "string" || !Array.isArray(thread.turns)) continue;
				for (const turn of thread.turns) {
					if (turn.status === "running") {
						turn.status = "aborted";
						turn.error = "Interrupted";
					}
				}
				this.threads.set(thread.anchorId, { ...thread, sentTurns: thread.sentTurns ?? 0 });
			}
		} catch {
			// A damaged thread file must not block the session; it is rewritten on the next change.
		}
	}

	get(anchorId: string): SideThread | undefined {
		return this.threads.get(anchorId);
	}

	all(): SideThread[] {
		return [...this.threads.values()];
	}

	getOrCreate(anchorId: string, anchorLabel: string, excerpt: string): SideThread {
		let thread = this.threads.get(anchorId);
		if (!thread) {
			thread = { anchorId, anchorLabel, excerpt, turns: [], sentTurns: 0, createdAt: Date.now() };
			this.threads.set(anchorId, thread);
		}
		return thread;
	}

	delete(anchorId: string): boolean {
		const deleted = this.threads.delete(anchorId);
		if (deleted) this.save();
		return deleted;
	}

	/** Write atomically; failures are ignored so a read-only session dir never breaks the UI. */
	save(): void {
		if (!this.file) return;
		try {
			if (this.threads.size === 0) {
				rmSync(this.file, { force: true });
				return;
			}
			mkdirSync(dirname(this.file), { recursive: true });
			const data: SideThreadFile = { version: 1, threads: this.all() };
			const tmp = `${this.file}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(data), "utf8");
			renameSync(tmp, this.file);
		} catch {
			// Best effort: threads stay available in memory.
		}
	}
}

function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.7);
	return `${text.slice(0, head)}\n… [${text.length - max} chars omitted] …\n${text.slice(text.length - (max - head))}`;
}

function messageText(message: AgentMessage): string {
	if (message.role === "user") {
		return typeof message.content === "string"
			? message.content
			: message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
	}
	if (message.role === "assistant") {
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

/** User and assistant text from the end of the transcript, newest last, within `budget` chars. */
export function recentTranscript(messages: readonly AgentMessage[], budget: number): string {
	const parts: string[] = [];
	let used = 0;
	for (let i = messages.length - 1; i >= 0 && used < budget; i--) {
		const message = messages[i]!;
		const text = messageText(message).trim();
		if (!text) continue;
		const part = `${message.role === "user" ? "User" : "Assistant"}: ${clip(text, Math.min(2000, budget - used))}`;
		parts.unshift(part);
		used += part.length;
	}
	return parts.join("\n\n");
}

function priorTurns(thread: SideThread): string {
	const done = thread.turns.filter((turn) => turn.status === "done" && turn.answer.trim());
	if (done.length === 0) return "";
	return `Earlier in this side thread:\n${done.map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`).join("\n\n")}\n\n`;
}

function sideQuestion(thread: SideThread, question: string, excerptChars: number): string {
	return (
		"[Side question from the user about one item in this coding session. Answer it directly and briefly " +
		"from what you can see. Do not call tools, do not continue the main task, and do not propose to run anything; " +
		"the main agent will not see this exchange.]\n\n" +
		`Item: ${thread.anchorLabel}\n<item>\n${clip(thread.excerpt, excerptChars)}\n</item>\n\n` +
		priorTurns(thread) +
		`Question: ${question}`
	);
}

const SIDE_SYSTEM_PROMPT =
	"You answer short side questions about a coding agent session. You see one item from the session " +
	"(a tool call with its output, or an assistant reply) and possibly some recent conversation. " +
	"Answer in a few sentences or a short list. Cite line numbers or exact text from the item when it helps. " +
	"If the item does not contain the answer, say so instead of guessing.";

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

export interface SideThreadRequest {
	model: Model<Api>;
	context: Context;
	options: ModelsSimpleStreamOptions;
}

/**
 * Build the request for one turn.
 *
 * - `same` with a current session request: the main request plus one user message, so the
 *   provider reuses the cached prefix and the model sees the whole session. Tools stay
 *   declared because providers reject tool calls in history without their declarations.
 * - `other`: a short system prompt, recent conversation text, and the item.
 * - `local`: the item only, clipped to the delegate_local budget.
 */
export function buildSideThreadRequest(params: {
	model: Model<Api>;
	kind: SideThreadModelKind;
	thread: SideThread;
	question: string;
	lastRequest: SessionModelRequest | undefined;
	transcript: readonly AgentMessage[];
	signal: AbortSignal;
}): SideThreadRequest {
	const { model, kind, thread, question, lastRequest, transcript, signal } = params;
	const sameRequest =
		kind === "same" && lastRequest?.model.provider === model.provider && lastRequest.model.id === model.id
			? lastRequest
			: undefined;
	if (sameRequest) {
		return {
			model: sameRequest.model,
			context: {
				...sameRequest.context,
				messages: [...sameRequest.context.messages, userMessage(sideQuestion(thread, question, MAX_EXCERPT_CHARS))],
			},
			options: { ...sameRequest.options, signal },
		};
	}
	if (kind === "local") {
		return {
			model,
			context: {
				systemPrompt: SIDE_SYSTEM_PROMPT,
				messages: [userMessage(sideQuestion(thread, question, LOCAL_EXCERPT_CHARS))],
			},
			options: { signal, maxTokens: Math.min(LOCAL_MAX_TOKENS, model.maxTokens) },
		};
	}
	const recent = recentTranscript(transcript, RECENT_TRANSCRIPT_CHARS);
	const background = recent
		? `Recent conversation in the session:\n<conversation>\n${recent}\n</conversation>\n\n`
		: "";
	return {
		model,
		context: {
			systemPrompt: SIDE_SYSTEM_PROMPT,
			messages: [userMessage(background + sideQuestion(thread, question, MAX_EXCERPT_CHARS))],
		},
		options: { signal, maxTokens: Math.min(OTHER_MAX_TOKENS, model.maxTokens) },
	};
}

/**
 * Stream one turn. `onUpdate` receives the answer text so far. Tool calls the model
 * makes anyway are dropped; only text is kept.
 */
export async function runSideThreadTurn(
	modelRuntime: Pick<ModelRuntime, "streamSimple">,
	request: SideThreadRequest,
	onUpdate: (answer: string) => void,
): Promise<AssistantMessage> {
	const stream = modelRuntime.streamSimple(request.model, request.context, request.options);
	for await (const event of stream) {
		if (event.type === "text_delta" || event.type === "text_end") {
			onUpdate(messageText(event.partial));
		}
	}
	return stream.result();
}

/** Final answer text for a finished turn, with a note when the model only tried to call tools. */
export function answerText(message: AssistantMessage): string {
	const text = messageText(message).trim();
	if (text) return text;
	if (message.content.some((part) => part.type === "toolCall")) {
		return "(The model tried to call a tool instead of answering. Side threads cannot run tools.)";
	}
	return "";
}

/** The main-context message for "send to main": turns not sent yet, as plain text. */
export function formatThreadForMain(thread: SideThread): string {
	const turns = thread.turns.slice(thread.sentTurns).filter((turn) => turn.status === "done");
	const body = turns.map((turn) => `Q: ${turn.question}\nA (${turn.model.id}): ${turn.answer}`).join("\n\n");
	return `Side thread about ${thread.anchorLabel}:\n\n${body}`;
}

/** A transcript item a thread can attach to. */
export interface ThreadAnchor {
	id: string;
	label: string;
	excerpt: string;
}

const LABEL_ARG_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "kind"];

function oneLine(text: string, max = 80): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function toolCallAnchor(
	toolName: string,
	toolCallId: string,
	args: unknown,
	result: { content: ReadonlyArray<{ type: string; text?: string }>; isError: boolean } | undefined,
	running: boolean,
): ThreadAnchor {
	const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
	const key = LABEL_ARG_KEYS.find((name) => typeof record[name] === "string" && record[name]);
	const label = key ? `${toolName} ${oneLine(String(record[key]))}` : toolName;
	const output = result
		? result.content
				.filter((part) => part.type === "text" && part.text)
				.map((part) => part.text)
				.join("\n")
		: "";
	const status = running ? "still running" : result?.isError ? "failed" : "succeeded";
	const excerpt = `Tool call: ${toolName} (${status})\nArguments: ${clip(JSON.stringify(args ?? {}, null, 2), 4000)}\nOutput:\n${output || "(none)"}`;
	return { id: `tool:${toolCallId}`, label, excerpt: clip(excerpt, MAX_EXCERPT_CHARS) };
}

/** Assistant replies with visible text; replies that only call tools are not anchors. */
export function assistantAnchorId(message: AssistantMessage): string | undefined {
	return message.content.some((part) => part.type === "text" && part.text.trim())
		? `assistant:${message.timestamp}`
		: undefined;
}

export function assistantAnchor(message: AssistantMessage): ThreadAnchor | undefined {
	const id = assistantAnchorId(message);
	if (!id) return undefined;
	const text = messageText(message).trim();
	return {
		id,
		label: `reply "${oneLine(text, 60)}"`,
		excerpt: clip(`Assistant reply:\n${text}`, MAX_EXCERPT_CHARS),
	};
}
