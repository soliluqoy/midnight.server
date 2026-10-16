import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
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
const CUSTOM = "Type my own answer…";
const ANSWER_NOTICE = "Saved in the conversation and sent to the model — do not enter secrets.";
const QUESTION_MARK = "? ";
/** Uncolored so it inherits Pi's row color: accent on the selected row, text elsewhere. */
const CHOICE_MARK = "• ";
const DETAIL_INDENT = "  ";
const DETAIL_MARK = "↳ ";
/** Pi renders an option row as `  text` or `→ text`, with one column of padding per side. */
const OPTION_CHROME_WIDTH = 4;
const MIN_ROW_WIDTH = 16;
const display = (text: string) =>
	stripTerminalSequences(text)
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();

/** The theme tokens this dialog paints with; structural so tests and non-rendering modes can omit it. */
export interface QuestionTheme {
	fg(color: "warning" | "borderAccent" | "muted" | "dim", text: string): string;
	bold(text: string): string;
}

/** Pi's own fallback order for the render width. Only the TUI renders these strings itself. */
export function questionColumns(
	stdout: { columns?: number } = process.stdout,
	env: NodeJS.ProcessEnv = process.env,
): number {
	return stdout.columns || Number(env.COLUMNS) || 80;
}

const clip = (text: string, maxWidth: number) =>
	visibleWidth(text) <= maxWidth ? text : `${sliceByColumn(text, 0, Math.max(0, maxWidth - 1), true)}…`;

/**
 * Pi renders each option as one plain string and wraps it without a hanging indent, so a long label
 * and trade-off blur together. Each option gets a marker column (`→ •` on the selected row, `  •`
 * elsewhere, with the trade-off `↳` on its own indented row, clipped instead of growing the dialog).
 * Labels are never clipped, because two clipped labels could render identically and make the selector
 * report the wrong choice.
 */
export function formatQuestionOptions(
	options: readonly { label: string; description: string }[],
	{ columns, theme }: { columns?: number; theme?: QuestionTheme } = {},
): string[] {
	return options.map(({ label, description }) => {
		if (!columns || !theme) return description ? `${label} — ${description}` : label;
		const row = `${CHOICE_MARK}${theme.bold(label)}`;
		if (!description) return row;
		const rowWidth = Math.max(MIN_ROW_WIDTH, columns - OPTION_CHROME_WIDTH);
		if (visibleWidth(`${CHOICE_MARK}${label} — ${description}`) <= rowWidth)
			return `${row} — ${theme.fg("muted", description)}`;
		const detailWidth = Math.max(
			MIN_ROW_WIDTH,
			columns - OPTION_CHROME_WIDTH - DETAIL_INDENT.length - DETAIL_MARK.length,
		);
		return [
			row,
			`${DETAIL_INDENT}${theme.fg("dim", DETAIL_MARK.trimEnd())} ${theme.fg("muted", clip(description, detailWidth))}`,
		].join("\n");
	});
}

/**
 * `notice` moves the free-text privacy line into the title, because Pi ignores the input placeholder
 * in TUI mode; RPC clients still receive that text through the placeholder.
 */
export function formatQuestionTitle(
	question: string,
	{ theme, notice = false }: { theme?: QuestionTheme; notice?: boolean } = {},
): string {
	const head = theme
		? `${theme.fg("warning", QUESTION_MARK.trimEnd())} ${theme.bold(theme.fg("borderAccent", question))}`
		: `${QUESTION_MARK.trimEnd()} ${question}`;
	if (!notice) return head;
	return `${head}\n${theme ? theme.fg("muted", ANSWER_NOTICE) : ANSWER_NOTICE}`;
}

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
			"Ask one focused question with concrete alternatives and concise trade-offs; identify a recommendation when useful. Keep labels short and trade-offs to about one line: the dialog renders plain text and clips what does not fit. Do not ask about trivial implementation details, facts you can inspect, or decisions the user already made. Follow explicit requests to use your judgment within their scope.",
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
			const shown = options.map((option) => ({
				label: display(option.label),
				description: option.description ? display(option.description) : "",
			}));
			if (
				!question ||
				shown.some(({ label }) => !label) ||
				new Set(shown.map(({ label }) => label)).size !== shown.length
			)
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
				// Pi ignores the input placeholder in TUI mode, so the answer notice takes its place in the title there.
				const isTui = ctx.mode === "tui";
				const theme: QuestionTheme | undefined = isTui ? ctx.ui.theme : undefined;
				let index = -1;
				if (shown.length) {
					const choices = formatQuestionOptions(shown, { theme, columns: theme ? questionColumns() : undefined });
					// The free-text row shares the marker column in the TUI, but stays bare where options have no marker.
					const customRow = theme ? `${CHOICE_MARK}${CUSTOM}` : CUSTOM;
					const selected = await ctx.ui.select(formatQuestionTitle(question, { theme }), [...choices, customRow], {
						signal: combined,
					});
					if (combined.aborted || ctx.sessionManager.getSessionId() !== sessionId || selected === undefined)
						return result();
					index = choices.indexOf(selected);
					if (index < 0 && selected !== customRow) return unavailable("The dialog returned an unknown option.");
				}
				const answer =
					index >= 0
						? options[index].label
						: await ctx.ui.input(formatQuestionTitle(question, { theme, notice: isTui }), ANSWER_NOTICE, {
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
