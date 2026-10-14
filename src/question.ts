import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

export const QUESTION_TOOL = "midnight_question";
export const QuestionParams = Type.Object({
	question: Type.String({ minLength: 1, maxLength: 1000, description: "The decision the user needs to make" }),
	options: Type.Optional(
		Type.Array(
			Type.Object({
				label: Type.String({ minLength: 1, maxLength: 160 }),
				description: Type.Optional(Type.String({ maxLength: 300 })),
			}),
			{ maxItems: 6, description: "Concrete alternatives; omit or leave empty for a text answer" },
		),
	),
});
export const QuestionResult = Type.Object({
	version: Type.Literal(1),
	status: Type.Union([Type.Literal("answered"), Type.Literal("cancelled"), Type.Literal("unavailable")]),
	question: Type.String(),
	options: Type.Array(Type.String()),
	answer: Type.Union([Type.String(), Type.Null()]),
	selectedIndex: Type.Union([Type.Integer({ minimum: 1, maximum: 6 }), Type.Null()]),
	wasCustom: Type.Boolean(),
	reason: Type.String(),
});
export type QuestionData = Static<typeof QuestionResult>;
const CUSTOM = "Other — write my own answer…";
const display = (text: string) =>
	stripTerminalSequences(text)
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();

/** Native Pi dialogs own the editor and inherit its theme, keybindings, and RPC support. */
export function registerQuestion(pi: ExtensionAPI, beforeOpen: () => boolean = () => true) {
	let lifecycle = new AbortController();
	let active: symbol | undefined;
	const reset = () => {
		lifecycle.abort();
		lifecycle = new AbortController();
		active = undefined;
	};
	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);
	pi.on("session_tree", reset);

	pi.registerTool({
		name: QUESTION_TOOL,
		label: "Midnight question",
		description:
			"Ask the user one focused clarification or decision with selectable alternatives and an Other text answer. " +
			"Omit options for free text. No UI in print/JSON: ask in chat instead. Cancellation is not consent or a default answer. " +
			"Never request passwords, tokens, or other secrets; answers are saved in the conversation and sent to the coding model. " +
			"This is not a command-approval or sandbox tool.",
		promptSnippet: "Ask the user a meaningful clarification with selectable answers or free text",
		promptGuidelines: [
			"Use midnight_question before proceeding when missing requirements or a user preference materially change scope, behavior, architecture, compatibility, privacy, cost, or an irreversible action. Check available context first; do not guess consequential preferences.",
			"Ask one focused question with concrete alternatives and concise trade-offs; identify a recommendation when useful. Do not ask about trivial implementation details, facts you can inspect, or decisions the user already made. Follow explicit requests to use your judgment within their scope.",
			"If midnight_question is cancelled, do not pick a default, treat it as approval, or immediately ask again. Pause work that depends on the answer and explain what remains undecided. If UI is unavailable, ask in ordinary chat and wait. Never use this tool as a substitute for required permission checks.",
		],
		parameters: QuestionParams,
		outputSchema: QuestionResult,
		exposure: "model-only",
		executionMode: "sequential",
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
		async execute(_id, params, signal, _update, ctx) {
			const options = params.options ?? [];
			const data: QuestionData = {
				version: 1,
				status: "cancelled",
				question: params.question,
				options: options.map((option) => option.label),
				answer: null,
				selectedIndex: null,
				wasCustom: false,
				reason:
					"No answer was submitted. Pause work that depends on this decision; do not assume a default or re-prompt automatically.",
			};
			const result = () => ({
				content: [{ type: "text" as const, text: JSON.stringify(data) }],
				details: data,
				structuredContent: data,
				isError: data.status === "unavailable",
			});
			const unavailable = (reason: string) => {
				data.status = "unavailable";
				data.reason = `${reason} Ask in ordinary chat and wait for the user; do not assume an answer.`;
				return result();
			};
			const question = display(params.question);
			const labels = options.map((option) => display(option.label));
			if (!question || labels.some((label) => !label) || new Set(labels).size !== labels.length)
				return unavailable("Questions and option labels must be non-blank, with distinct labels.");
			if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc"))
				return unavailable("Interactive question UI is unavailable in this mode.");
			const combined = AbortSignal.any([lifecycle.signal, ...[signal, ctx.signal].filter((s) => s !== undefined)]);
			if (combined.aborted) return result();
			if (active) return unavailable("Another Midnight question is already open.");
			const token = Symbol();
			active = token;
			const sessionId = ctx.sessionManager.getSessionId();
			try {
				if (!beforeOpen()) return unavailable("Another Midnight dialog is open.");
				let index = -1;
				if (options.length) {
					const choices = options.map((option, i) => {
						const description = option.description ? display(option.description) : "";
						return `${i + 1}. ${labels[i]}${description ? ` — ${description}` : ""}`;
					});
					const selected = await ctx.ui.select(`Midnight · ${question}`, [...choices, CUSTOM], { signal: combined });
					if (combined.aborted || ctx.sessionManager.getSessionId() !== sessionId || selected === undefined)
						return result();
					index = choices.indexOf(selected);
					if (index < 0 && selected !== CUSTOM) return unavailable("The dialog returned an unknown option.");
				}
				const answer =
					index >= 0
						? options[index].label
						: await ctx.ui.input(`Midnight · ${question}`, "Your answer (saved in the conversation; no secrets)", {
								signal: combined,
							});
				if (combined.aborted || ctx.sessionManager.getSessionId() !== sessionId || !answer?.trim()) return result();
				if (answer.length > 4000) return unavailable("The answer exceeds 4,000 characters; it was not accepted.");
				data.status = "answered";
				data.answer = index >= 0 ? answer : answer.trim();
				data.selectedIndex = index >= 0 ? index + 1 : null;
				data.wasCustom = index < 0;
				data.reason = "Explicit user answer to this question only; not blanket permission for other actions.";
				return result();
			} catch (error) {
				if (combined.aborted) return result();
				throw error;
			} finally {
				// An old completion must not clear the active flag of a replacement session's question.
				if (active === token) active = undefined;
			}
		},
	});
	return {
		get active() {
			return active !== undefined;
		},
	};
}
