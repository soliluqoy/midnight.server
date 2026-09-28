import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultHarnessConfig, parseHarnessConfig } from "../src/harness/config.ts";
import { resolveFeatures } from "../src/harness/features.ts";
import {
	learningEnabled,
	PolicyError,
	pinnedPolicy,
	policyBaseConfig,
	policyHash,
	SEED_POLICY,
	validatePolicy,
} from "../src/harness/policy.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("harness policy", () => {
	it("accepts a valid policy and rejects unknown keys, bad bounds and protected features turned off", () => {
		const policy = validatePolicy({
			features: { fast: { mutationProbe: true } },
			params: { maxRepairRounds: 3, repeatSimilarity: 0.7, boostCeiling: "medium" },
		});
		expect(policy.features.fast?.mutationProbe).toBe(true);
		expect(() => validatePolicy({ features: {}, params: {}, extra: 1 })).toThrow(PolicyError);
		expect(() => validatePolicy({ features: { slow: {} } })).toThrow("unknown model class");
		expect(() => validatePolicy({ features: { fast: { noSuchFeature: true } } })).toThrow("unknown feature");
		expect(() => validatePolicy({ features: { fast: { driftGuard: false } } })).toThrow(
			"may not turn off driftGuard",
		);
		expect(() => validatePolicy({ features: { fast: { blockerExit: false } } })).toThrow("may not turn off");
		expect(() => validatePolicy({ params: { maxRepairRounds: 9 } })).toThrow("from 1 to 4");
		expect(() => validatePolicy({ params: { maxRepairRounds: 1.5 } })).toThrow("integer");
		expect(() => validatePolicy({ params: { boostCeiling: "max" } })).toThrow("boostCeiling");
		expect(policyHash(validatePolicy({}))).toBe(policyHash(SEED_POLICY));
	});

	it("layers class defaults, then the policy, then harness.json, then the environment", () => {
		const policyFeatures = { mutationProbe: true, lookup: false };
		expect(resolveFeatures("fast", {}, {}, policyFeatures).mutationProbe).toBe(true);
		expect(resolveFeatures("fast", {}, {}, policyFeatures).lookup).toBe(false);
		expect(resolveFeatures("fast", { lookup: true }, {}, policyFeatures).lookup).toBe(true);
		expect(resolveFeatures("fast", { lookup: true }, { lookup: false }, policyFeatures).lookup).toBe(false);
		expect(resolveFeatures("fast", {}, {}).mutationProbe).toBe(false);
	});

	it("applies parameters as the base that harness.json overrides", () => {
		const base = policyBaseConfig(defaultHarnessConfig(), {
			features: {},
			params: { maxRepairRounds: 3, mutationMaxMutants: 10 },
		});
		expect(base.maxRepairRounds).toBe(3);
		expect(base.mutation.maxMutants).toBe(10);
		const user = parseHarnessConfig({ maxRepairRounds: 1, mutation: { budgetSeconds: 30 } }, base);
		expect(user.maxRepairRounds).toBe(1);
		expect(user.mutation).toEqual({ maxMutants: 10, budgetSeconds: 30 });
		expect(() => parseHarnessConfig({ mutation: { typo: 1 } })).toThrow('Unknown key "mutation.typo"');
	});

	it("reads a pinned policy file and falls back to the seed with the reason", () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-policy-"));
		dirs.push(dir);
		const file = join(dir, "policy.json");
		writeFileSync(file, JSON.stringify({ features: { fast: { mutationProbe: true } } }));
		const pinned = pinnedPolicy({ MIDNIGHT_SERVER_HARNESS_POLICY: file });
		expect(pinned?.source).toBe("file");
		expect(pinned?.policy.features.fast?.mutationProbe).toBe(true);
		writeFileSync(file, JSON.stringify({ features: { fast: { parseGate: false } } }));
		const refused = pinnedPolicy({ MIDNIGHT_SERVER_HARNESS_POLICY: file });
		expect(refused?.source).toBe("seed");
		expect(refused?.problem).toContain("may not turn off parseGate");
		expect(pinnedPolicy({})).toBeUndefined();
	});

	it("learns unless turned off or pinned", () => {
		expect(learningEnabled({})).toBe(true);
		expect(learningEnabled({ MIDNIGHT_SERVER_HARNESS_LEARN: "0" })).toBe(false);
		expect(learningEnabled({ MIDNIGHT_SERVER_HARNESS_LEARN: "false" })).toBe(false);
		expect(learningEnabled({ MIDNIGHT_SERVER_HARNESS_POLICY: "x.json" })).toBe(false);
	});
});
