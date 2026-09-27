import type { AssistantMessage, Context } from "@earendil-works/pi-ai";

/**
 * Escalation: when a fast model is stuck, ask a stronger model for one piece of advice, then
 * hand control back to the fast model.
 *
 * Why advice and not a takeover: the stuck point is usually one wrong idea (wrong root
 * cause, wrong file). The strong model needs only the request, the current diff and the
 * failing output to name it, a few thousand input tokens and a short answer. The fast model
 * then does the routine work (edits, reruns) at its own price.
 *
 * Why not the whole transcript: it is the expensive part and mostly exploration noise. The
 * handoff is the state that matters, built by the harness.
 */

export interface EscalationRequest {
	/** The user's request for this run. */
	request: string;
	/** Current uncommitted change, bounded. */
	diff: string;
	/** What is failing: check output or the loop description, bounded. */
	failure: string;
	/** The fast model's latest explanation of what it tried, bounded. */
	attempt?: string;
	/** Paths the context pack ranked for this request. */
	relevantFiles: string[];
}

export type Completer = (context: Context, signal: AbortSignal) => Promise<AssistantMessage>;

const ADVISOR_PROMPT = [
	"You are a senior engineer advising a faster coding agent that is stuck.",
	"You get the user's request, the agent's current uncommitted diff, and what keeps failing.",
	"Find the root cause. Then give the smallest fix: name the file and the exact change, or the exact command.",
	"If the agent's approach is wrong, say so in one sentence and give the right approach.",
	"If a test or check is wrong or unrelated to the request, say so instead of changing code to satisfy it.",
	"Be brief: under 250 words. No preamble.",
].join("\n");

function bound(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n[... truncated ...]` : text;
}

export function escalationPrompt(input: EscalationRequest): string {
	return [
		`<request>\n${bound(input.request, 4_000)}\n</request>`,
		input.relevantFiles.length > 0 ? `<relevant_files>\n${input.relevantFiles.join("\n")}\n</relevant_files>` : "",
		`<current_diff>\n${bound(input.diff || "(no changes yet)", 14_000)}\n</current_diff>`,
		`<failing>\n${bound(input.failure, 6_000)}\n</failing>`,
		input.attempt ? `<agent_last_message>\n${bound(input.attempt, 2_000)}\n</agent_last_message>` : "",
		"What is the root cause, and what exactly should the agent do next?",
	]
		.filter(Boolean)
		.join("\n\n");
}

export interface EscalationAdvice {
	text: string;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
}

export async function requestAdvice(
	complete: Completer,
	input: EscalationRequest,
	signal: AbortSignal,
): Promise<EscalationAdvice | undefined> {
	const reply = await complete(
		{
			systemPrompt: ADVISOR_PROMPT,
			messages: [{ role: "user", content: escalationPrompt(input), timestamp: Date.now() }],
		},
		signal,
	);
	if (reply.stopReason !== "stop" && reply.stopReason !== "length") return undefined;
	const text = reply.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
	if (!text) return undefined;
	return {
		text,
		costUsd: reply.usage?.cost?.total ?? 0,
		inputTokens: reply.usage?.input ?? 0,
		outputTokens: reply.usage?.output ?? 0,
	};
}

export function formatAdvice(model: string, advice: EscalationAdvice): string {
	return [
		`Advice from ${model}, consulted by the harness because the same problem kept failing:`,
		advice.text,
		"",
		"Weigh this advice against what you see in the code, then continue.",
	].join("\n");
}
