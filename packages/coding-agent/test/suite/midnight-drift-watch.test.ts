import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createDriftWatchExtension, type DriftWatchSettings } from "../../src/midnight/drift-watch.ts";
import type { ChatRequest, ChatResult, LocalEngine } from "../../src/midnight/engine.ts";
import type { EngineManager } from "../../src/midnight/engine-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

function scriptedManager(reply: string): { manager: EngineManager; requests: ChatRequest[] } {
	const requests: ChatRequest[] = [];
	const engine = {
		async chat(request: ChatRequest): Promise<ChatResult> {
			requests.push(request);
			return { content: reply, finishReason: "stop", promptTokens: 20, completionTokens: 10 };
		},
	} as unknown as LocalEngine;
	const manager = { get: async () => engine, touch() {}, stop: async () => {} } as unknown as EngineManager;
	return { manager, requests };
}

/** Let the detached drift-check task (no real timers, only resolved promises) run to completion. */
async function flushBackgroundWork(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

const settings: DriftWatchSettings = { enabled: true, turnInterval: 2, tokenInterval: 1_000_000, cooldownTurns: 1 };

function hasDriftMessage(harness: Harness): boolean {
	return harness.session.messages.some(
		(message) => message.role === "custom" && message.customType === "midnight_drift_watch",
	);
}

describe("drift watch", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("does not check before the configured turn interval", async () => {
		const { manager, requests } = scriptedManager(JSON.stringify({ status: "on_track", reason: "fine" }));
		const harness = await createHarness({ extensionFactories: [createDriftWatchExtension(manager, settings)] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("do something");
		await flushBackgroundWork();

		expect(requests).toHaveLength(0);
	});

	it("checks at the turn interval and stays silent when on track", async () => {
		const { manager, requests } = scriptedManager(JSON.stringify({ status: "on_track", reason: "fine" }));
		const harness = await createHarness({ extensionFactories: [createDriftWatchExtension(manager, settings)] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);

		await harness.session.prompt("step one");
		await harness.session.prompt("step two");
		await flushBackgroundWork();
		await harness.session.prompt("step three");

		expect(requests).toHaveLength(1);
		expect(hasDriftMessage(harness)).toBe(false);
	});

	it("flags drift and injects a reminder on the following turn", async () => {
		const { manager, requests } = scriptedManager(
			JSON.stringify({ status: "drifting", reason: "lost the original constraint", reminder: "stay on the goal" }),
		);
		const harness = await createHarness({ extensionFactories: [createDriftWatchExtension(manager, settings)] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);

		await harness.session.prompt("step one");
		await harness.session.prompt("step two");
		await flushBackgroundWork();
		await harness.session.prompt("step three");

		expect(requests).toHaveLength(1);
		const drift = harness.session.messages.find(
			(message): message is Extract<typeof message, { role: "custom" }> =>
				message.role === "custom" && message.customType === "midnight_drift_watch",
		);
		expect(drift).toBeDefined();
		expect(drift?.details).toMatchObject({ status: "drifting", reminder: "stay on the goal" });
	});

	it("does not run checks when disabled", async () => {
		const { manager, requests } = scriptedManager(JSON.stringify({ status: "on_track", reason: "fine" }));
		const harness = await createHarness({
			extensionFactories: [createDriftWatchExtension(manager, { ...settings, enabled: false })],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);

		await harness.session.prompt("step one");
		await harness.session.prompt("step two");
		await flushBackgroundWork();

		expect(requests).toHaveLength(0);
	});
});
