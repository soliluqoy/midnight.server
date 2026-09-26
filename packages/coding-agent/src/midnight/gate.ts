import type { ChatMessage, ChatRequest, ChatResult, TokenLogprob } from "./engine.ts";

/** Minimal engine surface; mirrors helper.ts's HelperEngine. */
interface GateEngine {
	chat(request: ChatRequest): Promise<ChatResult>;
}

/** Alternatives requested for the gate token; a handful of labels sits well inside this. */
const GATE_TOP_LOGPROBS = 20;

/**
 * Turn a gate's first-token alternatives into a distribution over `labels`.
 * Each label must start with a distinct token: a token that prefixes exactly one
 * label carries that label's mass; the rest (text the grammar forbids) is dropped
 * and the remainder renormalized. Returns undefined when no label got any mass.
 */
export function labelProbabilities<L extends string>(
	top: TokenLogprob["top"],
	labels: readonly L[],
): Record<L, number> | undefined {
	const mass = Object.fromEntries(labels.map((label) => [label, 0])) as Record<L, number>;
	for (const alternative of top) {
		if (!alternative.token) continue;
		const matches = labels.filter((label) => label.startsWith(alternative.token));
		if (matches.length === 1) mass[matches[0]] += Math.exp(alternative.logprob);
	}
	const total = labels.reduce((sum, label) => sum + mass[label], 0);
	if (!(total > 0)) return undefined;
	for (const label of labels) mass[label] /= total;
	return mass;
}

/**
 * One grammar-constrained label token, read as probabilities. The engine reports
 * the raw softmax before the grammar, so the distribution is the model's own
 * preference among the labels, not the sampler's pick. Costs one forward pass over
 * whatever part of `messages` the engine has not cached. Returns undefined when the
 * engine gave no usable logprobs.
 */
export async function runLabelGate<L extends string>(
	engine: GateEngine,
	messages: ChatMessage[],
	labels: readonly L[],
	signal: AbortSignal,
): Promise<Record<L, number> | undefined> {
	const result = await engine.chat({
		messages,
		maxTokens: 8,
		temperature: 0,
		enableThinking: false,
		grammar: `root ::= ${labels.map((label) => JSON.stringify(label)).join(" | ")}`,
		topLogprobs: GATE_TOP_LOGPROBS,
		signal,
	});
	const first = result.logprobs?.[0];
	return first ? labelProbabilities(first.top, labels) : undefined;
}
