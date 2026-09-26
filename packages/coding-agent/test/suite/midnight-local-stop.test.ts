import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { EngineManager, LocalStoppedError } from "../../src/midnight/engine-manager.ts";
import { createDelegateExtension, createLocalProviderExtension } from "../../src/midnight/extension.ts";
import { getMidnightStatus, updateMidnightStatus } from "../../src/midnight/status.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("/local-stop and /local-start", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		updateMidnightStatus({ engine: "off" });
	});

	async function setup(): Promise<{ manager: EngineManager; harness: Harness }> {
		const manager = new EngineManager({ idleMs: 0 });
		const harness = await createHarness({
			extensionFactories: [
				createLocalProviderExtension(manager, { localOnly: false, contextSize: 8192 }),
				createDelegateExtension(manager),
			],
		});
		harnesses.push(harness);
		return { manager, harness };
	}

	it("stops the local model for the session without sending a prompt to the model", async () => {
		const { manager, harness } = await setup();
		await harness.session.prompt("/local-stop");
		expect(harness.session.messages).toHaveLength(0);
		expect(manager.isDisabled).toBe(true);
		expect(getMidnightStatus().engine).toBe("stopped");
		// Nothing can start it again: not the provider, delegate_local, nor drift watch.
		await expect(manager.get()).rejects.toBeInstanceOf(LocalStoppedError);
	});

	it("refuses delegate_local while stopped", async () => {
		const { harness } = await setup();
		harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), "delegate_local"]);
		await harness.session.prompt("/local-stop");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate_local", { kind: "summarize", instruction: "Summarize" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(true);
		expect(JSON.stringify(toolResult)).toContain("/local-stop");
		expect(getMidnightStatus().engine).toBe("stopped");
	});

	it("/local-start allows the engine to start again", async () => {
		const { manager, harness } = await setup();
		await harness.session.prompt("/local-stop");
		await harness.session.prompt("/local-start");
		expect(manager.isDisabled).toBe(false);
		expect(getMidnightStatus().engine).toBe("off");
	});
});
