import { afterEach, describe, expect, it } from "vitest";
import type { EngineManager } from "../../src/midnight/engine-manager.ts";
import { createLocalProviderExtension } from "../../src/midnight/extension.ts";
import { type LocalEngineState, updateMidnightStatus } from "../../src/midnight/status.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("/local-stop", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		updateMidnightStatus({ engine: "off" });
	});

	async function runLocalStop(engine: LocalEngineState): Promise<{ stops: number; harness: Harness }> {
		updateMidnightStatus({ engine });
		let stops = 0;
		const manager = {
			stop: async () => {
				stops++;
			},
		} as unknown as EngineManager;
		const harness = await createHarness({
			extensionFactories: [createLocalProviderExtension(manager, { localOnly: false, contextSize: 8192 })],
		});
		harnesses.push(harness);
		await harness.session.prompt("/local-stop");
		return { stops, harness };
	}

	it("stops a running engine without sending a prompt to the model", async () => {
		const { stops, harness } = await runLocalStop("ready");
		expect(stops).toBe(1);
		expect(harness.session.messages).toHaveLength(0);
	});

	it("does nothing when the engine is not running", async () => {
		const { stops } = await runLocalStop("off");
		expect(stops).toBe(0);
	});
});
