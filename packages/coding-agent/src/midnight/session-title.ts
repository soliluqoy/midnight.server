import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "../core/extensions/types.ts";
import type { SessionEntry } from "../core/session-manager.ts";

/** Sends one request to the session model. */
export type TitleCompleter = (context: Context, signal: AbortSignal) => Promise<AssistantMessage>;

const TITLE_SYSTEM_PROMPT = [
	"You name coding assistant sessions.",
	"Given the user's first request and the start of the reply, write a short title of 2 to 6 words that says what the session is about.",
	"No quotes, no trailing punctuation, no emojis.",
	"Reply with the title only.",
].join("\n");

const RETITLE_SYSTEM_PROMPT = [
	"You name coding assistant sessions.",
	"Given the session's current title and the user's recent requests, write a short title of 2 to 6 words that says what the session is about now.",
	"If the current title still fits, reply with it unchanged. Change it only when the focus of the work has clearly moved.",
	"No quotes, no trailing punctuation, no emojis.",
	"Reply with the title only.",
].join("\n");

/** Custom entry that records titles this extension set, so a resumed session knows which names it may replace. */
export const SESSION_TITLE_ENTRY_TYPE = "midnight-session-title";
/** Retitle at most once per this many completed agent runs... */
export const RETITLE_MIN_TURNS = 3;
/** ...and no sooner than this after the previous title. */
export const RETITLE_MIN_INTERVAL_MS = 5 * 60_000;
const RECENT_REQUESTS = 5;
const MAX_RECENT_REQUEST_CHARS = 400;

const MAX_TITLE_LENGTH = 60;
const MAX_EXCERPT_CHARS = 1_500;

function messageText(message: AgentMessage | undefined): string {
	if (!message || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join("\n")
		.trim();
}

/** Trim quotes, whitespace and trailing punctuation; reject empty or multi-line results. */
export function cleanSessionTitle(raw: string): string | undefined {
	const title = raw
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/[.!?:;,]+$/, "")
		.trim();
	if (!title) return undefined;
	return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : title;
}

async function requestTitle(
	complete: TitleCompleter,
	systemPrompt: string,
	prompt: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	const reply = await complete(
		{ systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
		signal,
	);
	if (reply.stopReason !== "stop") return undefined;
	const text = reply.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
	// A model that explains itself puts the title first; ignore the rest.
	return cleanSessionTitle(text.split(/\r?\n/, 1)[0] ?? "");
}

export function generateSessionTitle(
	complete: TitleCompleter,
	userText: string,
	assistantText: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	return requestTitle(
		complete,
		TITLE_SYSTEM_PROMPT,
		`<request>\n${userText.slice(0, MAX_EXCERPT_CHARS)}\n</request>\n<reply>\n${assistantText.slice(0, MAX_EXCERPT_CHARS)}\n</reply>`,
		signal,
	);
}

/** Ask for a title that fits the recent requests; the model returns the current title when it still fits. */
export function regenerateSessionTitle(
	complete: TitleCompleter,
	currentTitle: string,
	recentRequests: string[],
	signal: AbortSignal,
): Promise<string | undefined> {
	const requests = recentRequests
		.map((text) => `<request>\n${text.slice(0, MAX_RECENT_REQUEST_CHARS)}\n</request>`)
		.join("\n");
	return requestTitle(
		complete,
		RETITLE_SYSTEM_PROMPT,
		`<current_title>${currentTitle}</current_title>\n${requests}`,
		signal,
	);
}

/** Decide whether a titled session is due for another look. */
export function shouldRetitle(turnsSinceTitle: number, msSinceTitle: number): boolean {
	return turnsSinceTitle >= RETITLE_MIN_TURNS && msSinceTitle >= RETITLE_MIN_INTERVAL_MS;
}

function lastAutoTitle(entries: readonly SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type === "custom" && entry.customType === SESSION_TITLE_ENTRY_TYPE) {
			const title = (entry.data as { title?: unknown } | undefined)?.title;
			return typeof title === "string" ? title : undefined;
		}
	}
	return undefined;
}

function recentUserRequests(entries: readonly SessionEntry[]): string[] {
	const requests: string[] = [];
	for (let i = entries.length - 1; i >= 0 && requests.length < RECENT_REQUESTS; i--) {
		const entry = entries[i];
		if (entry?.type !== "message" || entry.message.role !== "user") continue;
		const text = messageText(entry.message);
		if (text) requests.unshift(text);
	}
	return requests;
}

/**
 * Name an unnamed session after its first exchange, using the session's own model,
 * then revisit the title in the background as the work moves on. Retitling waits for
 * both RETITLE_MIN_TURNS runs and RETITLE_MIN_INTERVAL_MS, and the model keeps the
 * current title unless the focus has changed. A name set with --name, /name, or by
 * another extension is never replaced.
 */
export function createSessionTitleExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let autoTitle: string | undefined;
		let turnsSinceTitle = 0;
		let lastTitledAt = 0;
		let inFlight = false;
		let controller: AbortController | undefined;

		pi.on("session_start", (_event, ctx) => {
			controller?.abort();
			inFlight = false;
			autoTitle = lastAutoTitle(ctx.sessionManager.getEntries());
			turnsSinceTitle = 0;
			lastTitledAt = Date.now();
		});

		pi.on("session_shutdown", () => {
			controller?.abort();
		});

		pi.on("agent_end", (event, ctx) => {
			if (!ctx.hasUI) return;
			turnsSinceTitle++;
			const model = ctx.model;
			if (inFlight || !model) return;
			const currentName = pi.getSessionName();
			// Someone else named the session; leave it alone.
			if (currentName && currentName !== autoTitle) return;

			let request: (complete: TitleCompleter, signal: AbortSignal) => Promise<string | undefined>;
			if (!currentName) {
				const userText = messageText(event.messages.find((message) => message.role === "user"));
				const assistantText = messageText(event.messages.find((message) => message.role === "assistant"));
				if (!userText) return;
				request = (complete, signal) => generateSessionTitle(complete, userText, assistantText, signal);
			} else {
				if (!shouldRetitle(turnsSinceTitle, Date.now() - lastTitledAt)) return;
				const requests = recentUserRequests(ctx.sessionManager.getBranch());
				if (requests.length === 0) return;
				request = (complete, signal) => regenerateSessionTitle(complete, currentName, requests, signal);
			}

			// Count this attempt even if it fails, so a flaky model is not asked every turn.
			turnsSinceTitle = 0;
			lastTitledAt = Date.now();
			inFlight = true;
			const requestController = new AbortController();
			controller = requestController;
			const signal = requestController.signal;
			const complete: TitleCompleter = (context, requestSignal) =>
				ctx.modelRegistry.complete(model, context, { signal: requestSignal });
			void (async () => {
				try {
					const title = await request(complete, signal);
					// Skip if the user renamed the session while the request ran.
					if (!title || signal.aborted || pi.getSessionName() !== currentName || title === currentName) return;
					autoTitle = title;
					pi.setSessionName(title);
					pi.appendEntry(SESSION_TITLE_ENTRY_TYPE, { title });
				} catch {
					// Titles are cosmetic; a failed request keeps the current title.
				} finally {
					if (controller === requestController) inFlight = false;
				}
			})();
		});
	};
}
