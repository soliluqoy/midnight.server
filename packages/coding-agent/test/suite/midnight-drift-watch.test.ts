import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import { createDriftWatchExtension, type DriftWatchSettings } from "../../src/midnight/drift-watch.ts";
import type { ChatRequest, ChatResult, LocalEngine } from "../../src/midnight/engine.ts";
import type { EngineManager } from "../../src/midnight/engine-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

type Reply = Partial<ChatResult>;

/** Replies are consumed in order; the last one repeats. */
function scriptedManager(...replies: Reply[]): { manager: EngineManager; requests: ChatRequest[] } {
	const requests: ChatRequest[] = [];
	const engine = {
		async chat(request: ChatRequest): Promise<ChatResult> {
			const reply = replies[Math.min(requests.length, replies.length - 1)];
			requests.push(request);
			return { content: "", finishReason: "stop", promptTokens: 20, completionTokens: 10, ...reply };
		},
	} as unknown as LocalEngine;
	const manager = { get: async () => engine, touch() {}, stop: async () => {} } as unknown as EngineManager;
	return { manager, requests };
}

/** A gate reply whose first token puts these probabilities on the three labels. */
function gate(onTrack: number, drifting: number, offTask: number): Reply {
	const top = [
		{ token: "on", logprob: Math.log(onTrack) },
		{ token: "dr", logprob: Math.log(drifting) },
		{ token: "off", logprob: Math.log(offTask) },
	];
	const best = top.reduce((a, b) => (b.logprob > a.logprob ? b : a));
	return { content: "", logprobs: [{ token: best.token, logprob: best.logprob, top }] };
}

function verdict(value: Record<string, string>): Reply {
	return { content: JSON.stringify(value) };
}

/** Let the detached drift-check task (no real timers, only resolved promises) run to completion. */
async function flushBackgroundWork(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

const settings: DriftWatchSettings = {
	enabled: true,
	turnInterval: 2,
	tokenInterval: 1_000_000,
	cooldownTurns: 1,
	nudgeConfidence: 0.5,
};

function driftMessage(harness: Harness) {
	return harness.session.messages.find(
		(message): message is Extract<typeof message, { role: "custom" }> =>
			message.role === "custom" && message.customType === "midnight_drift_watch",
	);
}

describe("drift watch", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function runTwoTurnsThenOne(manager: EngineManager): Promise<Harness> {
		const harness = await createHarness({ extensionFactories: [createDriftWatchExtension(manager, settings)] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
		await harness.session.prompt("step one");
		await harness.session.prompt("step two");
		await flushBackgroundWork();
		await harness.session.prompt("step three");
		return harness;
	}

	it("does not check before the configured turn interval", async () => {
		const { manager, requests } = scriptedManager(gate(0.9, 0.05, 0.05));
		const harness = await createHarness({ extensionFactories: [createDriftWatchExtension(manager, settings)] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("do something");
		await flushBackgroundWork();

		expect(requests).toHaveLength(0);
	});

	it("decides on track with a single grammar-constrained gate call", async () => {
		const { manager, requests } = scriptedManager(gate(0.7, 0.1, 0.2));
		const harness = await runTwoTurnsThenOne(manager);

		expect(requests).toHaveLength(1);
		expect(requests[0].grammar).toContain('"on_track"');
		expect(requests[0].topLogprobs).toBeGreaterThan(0);
		expect(requests[0].jsonSchema).toBeUndefined();
		expect(driftMessage(harness)).toBeUndefined();
	});

	it("explains a confident drift and injects a reminder on the following turn", async () => {
		const { manager, requests } = scriptedManager(
			gate(0.1, 0.7, 0.2),
			verdict({ status: "drifting", reason: "lost the original constraint", reminder: "stay on the goal" }),
		);
		const harness = await runTwoTurnsThenOne(manager);

		expect(requests).toHaveLength(2);
		const schema = requests[1].jsonSchema as { properties: { status: { enum: string[] } } };
		expect(schema.properties.status.enum).toEqual(["drifting"]);
		const drift = driftMessage(harness);
		expect(drift?.details).toMatchObject({ status: "drifting", reminder: "stay on the goal" });
		expect((drift?.details as { confidence?: { drifting: number } }).confidence?.drifting).toBeCloseTo(0.7);
	});

	it("keeps the gate and explain prompts on a shared cacheable prefix", async () => {
		const { manager, requests } = scriptedManager(
			gate(0.05, 0.05, 0.9),
			verdict({ status: "off_task", reason: "rewrote the README" }),
		);
		await runTwoTurnsThenOne(manager);

		expect(requests).toHaveLength(2);
		const [gateRequest, explainRequest] = requests;
		expect(explainRequest.messages[0]).toEqual(gateRequest.messages[0]);
		const gateUser = gateRequest.messages[1].content;
		const prefix = gateUser.slice(0, gateUser.indexOf("</transcript>") + "</transcript>".length);
		expect(explainRequest.messages[1].content.startsWith(prefix)).toBe(true);
	});

	it("stays quiet when the gate is below the nudge confidence", async () => {
		const { manager, requests } = scriptedManager(gate(0.55, 0.25, 0.2));
		const harness = await runTwoTurnsThenOne(manager);

		expect(requests).toHaveLength(1);
		expect(driftMessage(harness)).toBeUndefined();
	});

	it("still nudges with a generic reason when the explain call fails", async () => {
		const { manager } = scriptedManager(gate(0.1, 0.1, 0.8), { content: "not json" });
		const harness = await runTwoTurnsThenOne(manager);

		expect(driftMessage(harness)?.details).toMatchObject({
			status: "off_task",
			reason: "The local check is 90% confident the assistant is not on track.",
		});
	});

	it("falls back to a single full check when the engine returns no logprobs", async () => {
		const { manager, requests } = scriptedManager(
			{ content: "on_track" },
			verdict({ status: "drifting", reason: "lost the original constraint", reminder: "stay on the goal" }),
		);
		const harness = await runTwoTurnsThenOne(manager);

		expect(requests).toHaveLength(2);
		const schema = requests[1].jsonSchema as { properties: { status: { enum: string[] } } };
		expect(schema.properties.status.enum).toEqual(["on_track", "drifting", "off_task"]);
		expect(driftMessage(harness)?.details).toMatchObject({ status: "drifting", reminder: "stay on the goal" });
		expect((driftMessage(harness)?.details as { confidence?: unknown }).confidence).toBeUndefined();
	});

	it("drops a check cancelled by session shutdown without touching the stale ctx", async () => {
		let started!: () => void;
		const inFlight = new Promise<void>((resolve) => {
			started = resolve;
		});
		const engine = {
			chat(request: ChatRequest): Promise<ChatResult> {
				started();
				// Like an aborted fetch, reject on a later tick, after teardown has invalidated ctx.
				return new Promise((_resolve, reject) => {
					request.signal?.addEventListener("abort", () => setImmediate(() => reject(new Error("aborted"))));
				});
			},
		} as unknown as LocalEngine;
		const manager = { get: async () => engine, touch() {}, stop: async () => {} } as unknown as EngineManager;
		const harness = await createHarness({ extensionFactories: [createDriftWatchExtension(manager, settings)] });
		harness.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
		await harness.session.prompt("step one");
		await harness.session.prompt("step two");
		await inFlight;

		// Same order as AgentSessionRuntime teardown: shutdown handlers, then ctx invalidation.
		await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		harness.cleanup();
		// A throw from the detached check would surface here as an unhandled rejection.
		await flushBackgroundWork();
	});

	it("does not run checks when disabled", async () => {
		const { manager, requests } = scriptedManager(gate(0.9, 0.05, 0.05));
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
