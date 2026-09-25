import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionFactory } from "../core/extensions/types.ts";
import type { ChatRequest, ChatResult } from "./engine.ts";
import type { EngineManager } from "./engine-manager.ts";
import { MODEL_LOCK } from "./pins.ts";
import { findModel } from "./store.ts";

interface TitleEngine {
	chat(request: ChatRequest): Promise<ChatResult>;
}

const TITLE_SCHEMA = {
	type: "object",
	properties: { title: { type: "string", maxLength: 60 } },
	required: ["title"],
} as const;

const TITLE_SYSTEM_PROMPT = [
	"You name coding assistant sessions.",
	"Given the user's first request and the start of the reply, write a short title of 2 to 6 words that says what the session is about.",
	"No quotes, no trailing punctuation, no emojis.",
	"Respond with one JSON object matching the required schema.",
].join("\n");

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

export async function generateSessionTitle(
	engine: TitleEngine,
	userText: string,
	assistantText: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	const result = await engine.chat({
		messages: [
			{ role: "system", content: TITLE_SYSTEM_PROMPT },
			{
				role: "user",
				content: `<request>\n${userText.slice(0, MAX_EXCERPT_CHARS)}\n</request>\n<reply>\n${assistantText.slice(0, MAX_EXCERPT_CHARS)}\n</reply>`,
			},
		],
		maxTokens: 60,
		enableThinking: false,
		jsonSchema: TITLE_SCHEMA,
		signal,
	});
	if (result.finishReason === "length") return undefined;
	try {
		const value: unknown = JSON.parse(result.content);
		if (typeof value !== "object" || value === null) return undefined;
		const title = (value as Record<string, unknown>).title;
		return typeof title === "string" ? cleanSessionTitle(title) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Name an unnamed session after its first exchange, using the local model so it costs
 * no cloud tokens. Runs in the background once per session and never overrides a name
 * set with --name, /name, or by an extension. Skipped when the local model is not
 * installed yet: a cosmetic title is not worth a one-time 2.5 GiB download.
 */
export function createSessionTitleExtension(manager: EngineManager): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let attempted = false;
		let controller: AbortController | undefined;

		pi.on("session_start", () => {
			attempted = false;
		});

		pi.on("session_shutdown", () => {
			controller?.abort();
		});

		pi.on("agent_end", (event, ctx) => {
			if (attempted || !ctx.hasUI || pi.getSessionName()) return;
			const userText = messageText(event.messages.find((message) => message.role === "user"));
			const assistantText = messageText(event.messages.find((message) => message.role === "assistant"));
			if (!userText || (!manager.current && !findModel(MODEL_LOCK))) return;
			attempted = true;
			controller = new AbortController();
			const signal = controller.signal;
			void (async () => {
				try {
					const engine = await manager.get(signal);
					manager.touch();
					const title = await generateSessionTitle(engine, userText, assistantText, signal);
					if (title && !pi.getSessionName()) pi.setSessionName(title);
				} catch {
					// Titles are cosmetic; a missing local model or a failed request just leaves the session unnamed.
				}
			})();
		});
	};
}
