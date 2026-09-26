import { describe, expect, it } from "vitest";
import { buildChatBody, parseChatPayload } from "../src/midnight/engine.ts";

describe("buildChatBody", () => {
	it("keeps the helper defaults and omits optional fields", () => {
		const body = buildChatBody({ messages: [{ role: "user", content: "hi" }], maxTokens: 4 });
		expect(body).toMatchObject({ max_tokens: 4, temperature: 1.0, top_p: 0.95, min_p: 0, stream: false });
		expect(body).not.toHaveProperty("grammar");
		expect(body).not.toHaveProperty("logprobs");
		expect(body).not.toHaveProperty("response_format");
	});

	it("passes a grammar and requests top logprobs", () => {
		const body = buildChatBody({
			messages: [{ role: "user", content: "hi" }],
			maxTokens: 8,
			temperature: 0,
			grammar: 'root ::= "a" | "b"',
			topLogprobs: 20,
			enableThinking: false,
		});
		expect(body).toMatchObject({
			temperature: 0,
			grammar: 'root ::= "a" | "b"',
			logprobs: true,
			top_logprobs: 20,
			chat_template_kwargs: { enable_thinking: false },
		});
	});
});

describe("parseChatPayload", () => {
	it("maps a completion without logprobs", () => {
		const result = parseChatPayload({
			choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 2 },
			timings: { prompt_ms: 5, predicted_ms: 7 },
		});
		expect(result).toEqual({
			content: "ok",
			reasoning: undefined,
			finishReason: "stop",
			promptTokens: 10,
			completionTokens: 2,
			promptMs: 5,
			predictedMs: 7,
			logprobs: undefined,
		});
	});

	it("maps llama-server logprobs", () => {
		// Trimmed from a real MiniCPM5-2B / llama.cpp b11166 response.
		const result = parseChatPayload({
			choices: [
				{
					message: { content: "on_track" },
					finish_reason: "stop",
					logprobs: {
						content: [
							{
								token: "on",
								logprob: -0.359,
								top_logprobs: [
									{ token: "on", logprob: -0.359 },
									{ token: "off", logprob: -1.698 },
								],
							},
						],
					},
				},
			],
		});
		expect(result.logprobs).toEqual([
			{
				token: "on",
				logprob: -0.359,
				top: [
					{ token: "on", logprob: -0.359 },
					{ token: "off", logprob: -1.698 },
				],
			},
		]);
	});
});
