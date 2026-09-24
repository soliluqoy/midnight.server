import { afterEach, describe, expect, it } from "vitest";
import { resolveDriftWatchSettings } from "../src/midnight/drift-watch.ts";

const ENV_KEYS = [
	"MIDNIGHT_SERVER_DRIFTWATCH",
	"MIDNIGHT_SERVER_DRIFTWATCH_TURNS",
	"MIDNIGHT_SERVER_DRIFTWATCH_TOKENS",
	"MIDNIGHT_SERVER_DRIFTWATCH_COOLDOWN",
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
	it("defaults to enabled with a 6-turn / 4000-token cadence and a 4-turn cooldown", () => {
		for (const key of ENV_KEYS) delete process.env[key];
		expect(resolveDriftWatchSettings()).toEqual({
			enabled: true,
			turnInterval: 6,
			tokenInterval: 4000,
			cooldownTurns: 4,
		});
	});

	it("reads environment variables", () => {
		process.env.MIDNIGHT_SERVER_DRIFTWATCH = "0";
		process.env.MIDNIGHT_SERVER_DRIFTWATCH_TURNS = "3";
		process.env.MIDNIGHT_SERVER_DRIFTWATCH_TOKENS = "1000";
		process.env.MIDNIGHT_SERVER_DRIFTWATCH_COOLDOWN = "1";
		expect(resolveDriftWatchSettings()).toEqual({
			enabled: false,
			turnInterval: 3,
			tokenInterval: 1000,
			cooldownTurns: 1,
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
});
