import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "../core/extensions/types.ts";

/** Sends one request to the session model. */
export type TitleCompleter = (context: Context, signal: AbortSignal) => Promise<AssistantMessage>;

const TITLE_SYSTEM_PROMPT = [
	"You name coding assistant sessions.",
	"Given the user's first request and the start of the reply, write a short title of 2 to 6 words that says what the session is about.",
	"No quotes, no trailing punctuation, no emojis.",
	"Reply with the title only.",
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
	complete: TitleCompleter,
	userText: string,
	assistantText: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	const reply = await complete(
		{
			systemPrompt: TITLE_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: `<request>\n${userText.slice(0, MAX_EXCERPT_CHARS)}\n</request>\n<reply>\n${assistantText.slice(0, MAX_EXCERPT_CHARS)}\n</reply>`,
					timestamp: Date.now(),
				},
			],
		},
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

/**
 * Name an unnamed session after its first exchange, using the session's own model.
 * Runs in the background once per session and never overrides a name set with
 * --name, /name, or by an extension.
 */
export function createSessionTitleExtension(): ExtensionFactory {
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
			const model = ctx.model;
			const userText = messageText(event.messages.find((message) => message.role === "user"));
			const assistantText = messageText(event.messages.find((message) => message.role === "assistant"));
			if (!model || !userText) return;
			attempted = true;
			controller = new AbortController();
			const signal = controller.signal;
			const complete: TitleCompleter = (context, requestSignal) =>
				ctx.modelRegistry.complete(model, context, { signal: requestSignal });
			void (async () => {
				try {
					const title = await generateSessionTitle(complete, userText, assistantText, signal);
					if (title && !pi.getSessionName()) pi.setSessionName(title);
				} catch {
					// Titles are cosmetic; a failed request just leaves the session unnamed.
				}
			})();
		});
	};
}
