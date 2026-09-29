import { describe, expect, it } from "vitest";
import { clampMaxTokensToContext, contextSafetyTokens } from "../src/api/simple-options.ts";
import type { Api, Model, TranscriptContext } from "../src/types.ts";

function model(contextWindow: number): Model<Api> {
	return { contextWindow, maxTokens: contextWindow / 2 } as Model<Api>;
}

function contextOf(chars: number): TranscriptContext {
	return { messages: [{ role: "user", content: "x".repeat(chars), timestamp: 0 }] } as TranscriptContext;
}

describe("context safety margin", () => {
	it("keeps 4096 for large windows and scales down for small ones", () => {
		expect(contextSafetyTokens(200_000)).toBe(4096);
		expect(contextSafetyTokens(65_536)).toBe(4096);
		expect(contextSafetyTokens(8_192)).toBe(512);
	});

	it("leaves an 8K model real output room at half its window", () => {
		// ~4.3K tokens of context, where the fixed 4096 margin used to clamp to one token.
		const maxTokens = clampMaxTokensToContext(model(8_192), contextOf(4_300 * 4), 4_096);
		expect(maxTokens).toBeGreaterThan(3_000);
	});
});
