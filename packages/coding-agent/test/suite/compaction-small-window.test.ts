import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionBeforeCompactEvent } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * With default compaction settings (reserve 16,384, keep 20,000), an 8K-window model such as
 * the embedded MiniCPM could never compact: the keep window exceeded the whole context, so
 * compaction found nothing to summarize and the session overflowed. The settings now fit
 * the model's window.
 */
describe("compaction in a small context window", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("compacts an 8K-window session with default settings", async () => {
		const preparations: SessionBeforeCompactEvent[] = [];
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 8192 }],
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						preparations.push(event);
						return {
							compaction: {
								summary: "compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const model = harness.session.model!;
		for (let index = 0; index < 8; index++) {
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `request ${index} `.padEnd(2400, "x") }],
				timestamp: Date.now() - 2000,
			});
			const assistant = fauxAssistantMessage(`answer ${index} `.padEnd(2400, "y"), { timestamp: Date.now() - 1000 });
			harness.sessionManager.appendMessage({
				...assistant,
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { ...assistant.usage, input: 800 * (index + 1), totalTokens: 800 * (index + 1) },
			});
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("continue");

		expect(preparations).toHaveLength(1);
		expect(preparations[0]?.preparation.settings).toMatchObject({ reserveTokens: 2048, keepRecentTokens: 3072 });
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
	});
});
