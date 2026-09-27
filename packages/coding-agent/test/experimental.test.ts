import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.MIDNIGHT_SERVER_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.MIDNIGHT_SERVER_EXPERIMENTAL;
		} else {
			process.env.MIDNIGHT_SERVER_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when MIDNIGHT_SERVER_EXPERIMENTAL is unset", () => {
		delete process.env.MIDNIGHT_SERVER_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when MIDNIGHT_SERVER_EXPERIMENTAL is empty", () => {
		process.env.MIDNIGHT_SERVER_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when MIDNIGHT_SERVER_EXPERIMENTAL is set to 1", () => {
		process.env.MIDNIGHT_SERVER_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when MIDNIGHT_SERVER_EXPERIMENTAL is set to 0", () => {
		process.env.MIDNIGHT_SERVER_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when MIDNIGHT_SERVER_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.MIDNIGHT_SERVER_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
