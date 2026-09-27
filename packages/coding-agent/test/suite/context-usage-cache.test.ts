import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession.getContextUsage caching", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("recomputes after new entries, branch navigation, and context window changes", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 10_000, maxTokens: 100 },
				{ id: "faux-2", contextWindow: 20_000, maxTokens: 100 },
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second ".repeat(200))]);

		await harness.session.prompt("first prompt");
		const first = harness.session.getContextUsage();
		const firstLeaf = harness.sessionManager.getLeafId();
		expect(first?.tokens).toBeGreaterThan(0);
		expect(harness.session.getContextUsage()).toEqual(first);

		await harness.session.prompt(`second prompt ${"x".repeat(2_000)}`);
		const second = harness.session.getContextUsage();
		expect(second!.tokens!).toBeGreaterThan(first!.tokens!);

		harness.sessionManager.branch(firstLeaf!);
		expect(harness.session.getContextUsage()).toEqual(first);

		await harness.session.setModel(harness.getModel("faux-2")!);
		const wider = harness.session.getContextUsage();
		expect(wider?.contextWindow).toBe(20_000);
		expect(wider?.tokens).toBe(first?.tokens);
	});
});
