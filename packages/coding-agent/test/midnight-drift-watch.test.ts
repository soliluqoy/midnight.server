import { afterEach, describe, expect, it } from "vitest";
import { gateProbabilities, resolveDriftWatchSettings } from "../src/midnight/drift-watch.ts";

const ENV_KEYS = [
	"MIDNIGHT_SERVER_DRIFTWATCH",
	"MIDNIGHT_SERVER_DRIFTWATCH_TURNS",
	"MIDNIGHT_SERVER_DRIFTWATCH_TOKENS",
	"MIDNIGHT_SERVER_DRIFTWATCH_COOLDOWN",
	"MIDNIGHT_SERVER_DRIFTWATCH_CONFIDENCE",
] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
});

describe("resolveDriftWatchSettings", () => {
	it("defaults to enabled with a 6-turn / 4000-token cadence, a 4-turn cooldown and 0.5 confidence", () => {
		for (const key of ENV_KEYS) delete process.env[key];
		expect(resolveDriftWatchSettings()).toEqual({
			enabled: true,
			turnInterval: 6,
			tokenInterval: 4000,
			cooldownTurns: 4,
			nudgeConfidence: 0.5,
		});
	});

	it("reads environment variables", () => {
		process.env.MIDNIGHT_SERVER_DRIFTWATCH = "0";
		process.env.MIDNIGHT_SERVER_DRIFTWATCH_TURNS = "3";
		process.env.MIDNIGHT_SERVER_DRIFTWATCH_TOKENS = "1000";
		process.env.MIDNIGHT_SERVER_DRIFTWATCH_COOLDOWN = "1";
		process.env.MIDNIGHT_SERVER_DRIFTWATCH_CONFIDENCE = "0.8";
		expect(resolveDriftWatchSettings()).toEqual({
			enabled: false,
			turnInterval: 3,
			tokenInterval: 1000,
			cooldownTurns: 1,
			nudgeConfidence: 0.8,
		});
	});

	it("lets explicit overrides win over the environment", () => {
		process.env.MIDNIGHT_SERVER_DRIFTWATCH_TURNS = "3";
		expect(resolveDriftWatchSettings({ turnInterval: 9 }).turnInterval).toBe(9);
	});

	it("rejects an invalid boolean", () => {
		process.env.MIDNIGHT_SERVER_DRIFTWATCH = "maybe";
		expect(() => resolveDriftWatchSettings()).toThrow(/MIDNIGHT_SERVER_DRIFTWATCH/);
	});

	it("rejects a negative interval", () => {
		process.env.MIDNIGHT_SERVER_DRIFTWATCH_TURNS = "-1";
		expect(() => resolveDriftWatchSettings()).toThrow(/MIDNIGHT_SERVER_DRIFTWATCH_TURNS/);
	});

	it("rejects a confidence outside 0-1", () => {
		process.env.MIDNIGHT_SERVER_DRIFTWATCH_CONFIDENCE = "1.5";
		expect(() => resolveDriftWatchSettings()).toThrow(/MIDNIGHT_SERVER_DRIFTWATCH_CONFIDENCE/);
	});
});

describe("gateProbabilities", () => {
	it("maps first tokens to statuses and renormalizes over them", () => {
		// Shape measured on MiniCPM5-2B: labels tokenize as on|_track, dr|ifting, off|_task.
		const probabilities = gateProbabilities([
			{ token: "on", logprob: Math.log(0.6) },
			{ token: "off", logprob: Math.log(0.2) },
			{ token: "dr", logprob: Math.log(0.1) },
			{ token: "The", logprob: Math.log(0.1) },
		]);
		expect(probabilities?.on_track).toBeCloseTo(0.6 / 0.9);
		expect(probabilities?.off_task).toBeCloseTo(0.2 / 0.9);
		expect(probabilities?.drifting).toBeCloseTo(0.1 / 0.9);
	});

	it("ignores tokens that prefix more than one label", () => {
		const probabilities = gateProbabilities([
			{ token: "o", logprob: Math.log(0.5) },
			{ token: "drift", logprob: Math.log(0.5) },
		]);
		expect(probabilities).toEqual({ on_track: 0, drifting: 1, off_task: 0 });
	});

	it("returns undefined when no alternative matches a label", () => {
		expect(gateProbabilities([{ token: "The", logprob: 0 }])).toBeUndefined();
		expect(gateProbabilities([])).toBeUndefined();
	});
});
