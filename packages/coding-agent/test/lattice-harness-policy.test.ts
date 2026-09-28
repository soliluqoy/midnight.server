import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HarnessEpisode, PROTECTED_FEATURES, SEED_POLICY } from "../src/harness/policy.ts";
import {
	CANARY,
	HARNESS_POLICY_SKILL,
	HarnessPolicyCore,
	policyMutations,
	TRIAL,
	trialGate,
} from "../src/lattice/harness-policy.ts";

const dirs: string[] = [];
const cores: HarnessPolicyCore[] = [];
/**
 * The model class the running trial's candidate is about: a per-class toggle only counts episodes
 * of its class, so the sessions below run that class. Which candidate a trial picks is the bandit's
 * choice, not something these tests pin.
 */
let episodeClass: HarnessEpisode["model_class"] = "fast";
afterEach(() => {
	episodeClass = "fast";
	while (cores.length > 0) cores.pop()!.close();
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function open(dir?: string): HarnessPolicyCore {
	const dataDir = dir ?? mkdtempSync(join(tmpdir(), "lattice-harness-"));
	if (!dir) dirs.push(dataDir);
	const core = HarnessPolicyCore.open(dataDir);
	cores.push(core);
	return core;
}

function episode(resolved: boolean, options: Partial<HarnessEpisode> = {}): HarnessEpisode {
	return {
		at: Date.now(),
		policy_hash: "",
		model_class: episodeClass,
		checked: true,
		final_failed: !resolved,
		blocker: false,
		repair_rounds: 0,
		rollbacks: 0,
		drift_actionable: 0,
		escalations: 0,
		boosts: 0,
		tokens: 1000,
		...options,
	};
}

/** Settle `count` requests in sessions on the given arm; `resolved(i)` decides each outcome. */
function settle(
	core: HarnessPolicyCore,
	arm: "active" | "candidate",
	count: number,
	resolved: (index: number) => boolean,
) {
	const decisions = [];
	for (let index = 0; index < count; index++) {
		const assignment = core.assign(() => (arm === "candidate" ? 0 : 0.99));
		const decision = core.record(assignment, episode(resolved(index)));
		if (decision?.kind === "trial_started")
			episodeClass = decision.detail.includes(":frontier:") ? "frontier" : "fast";
		if (decision) decisions.push(decision);
	}
	return decisions;
}

describe("harness policy in Lattice", () => {
	it("installs the seed as the first champion", () => {
		const core = open();
		const active = core.active();
		expect(active.status).toBe("champion");
		expect(active.policy).toEqual(SEED_POLICY);
		expect(core.assign().arm).toBe("active");
		expect(core.store.verify().ok).toBe(true);
	});

	it("never proposes turning off a protected feature or escalation", () => {
		const operators = policyMutations(SEED_POLICY).map((candidate) => candidate.operator);
		for (const name of [...PROTECTED_FEATURES, "escalation", "masking"]) {
			expect(operators.some((operator) => operator.endsWith(`:${name}`))).toBe(false);
		}
		expect(operators).toContain("toggle:fast:mutationProbe");
		expect(operators).toContain("step:maxRepairRounds:up");
		expect(operators).toContain("step:boostCeiling:up");
	});

	it("starts a trial after the cooldown, promotes a better candidate to canary, then confirms it", () => {
		const core = open();
		expect(settle(core, "active", TRIAL.cooldownEpisodes - 1, () => true)).toEqual([]);
		const [started] = settle(core, "active", 1, () => true);
		expect(started.kind).toBe("trial_started");
		const trialAssignment = core.assign(() => 0);
		expect(trialAssignment.arm).toBe("candidate");
		expect(trialAssignment.trial).toBeDefined();
		expect(core.assign(() => 0.99).arm).toBe("active");

		// A toggle for one model class only counts that class's episodes; settle() runs that class.
		settle(core, "active", TRIAL.minEpisodes, (index) => index % 2 === 0);
		const decisions = settle(core, "candidate", TRIAL.minEpisodes, () => true);
		expect(decisions.map((decision) => decision.kind)).toEqual(["promoted"]);
		expect(decisions[0].gate?.route).toBe("success");
		const promoted = core.active();
		expect(promoted.status).toBe("canary");
		expect(promoted.hash).toBe(trialAssignment.hash);

		// The canary serves everyone; enough good episodes confirm it.
		const confirmed = settle(core, "active", CANARY.confirmEpisodes, () => true);
		expect(confirmed.map((decision) => decision.kind)).toEqual(["confirmed"]);
		expect(core.active().status).toBe("champion");
		const audit = core.store.auditLog(HARNESS_POLICY_SKILL).map((row) => row.kind);
		expect(audit).toContain("promote");
		expect(audit).toContain("champion");
		expect(core.store.verify().ok).toBe(true);
	});

	it("rolls a canary back when it resolves fewer requests than its parent", () => {
		const core = open();
		settle(core, "active", TRIAL.cooldownEpisodes, () => true);
		settle(core, "active", TRIAL.minEpisodes, (index) => index % 3 !== 0);
		settle(core, "candidate", TRIAL.minEpisodes, () => true);
		const canary = core.active();
		expect(canary.status).toBe("canary");
		const decisions = settle(core, "active", CANARY.minEpisodes, () => false);
		expect(decisions.map((decision) => decision.kind)).toEqual(["rolled_back"]);
		const back = core.active();
		expect(back.version).toBe(canary.parent);
		expect(back.status).toBe("champion");
	});

	it("rejects a candidate that never beats its parent, at the cap, and does not try it again", () => {
		const core = open();
		settle(core, "active", TRIAL.cooldownEpisodes, () => true);
		const candidate = core.assign(() => 0);
		settle(core, "active", TRIAL.maxEpisodes, () => true);
		const decisions = settle(core, "candidate", TRIAL.maxEpisodes, () => true);
		expect(decisions.map((decision) => decision.kind)).toEqual(["rejected"]);
		expect(core.active().version).toBe(1);
		// After the cooldown a new trial starts with a different candidate.
		const next = settle(core, "active", TRIAL.cooldownEpisodes, () => true);
		expect(next.map((decision) => decision.kind)).toEqual(["trial_started"]);
		expect(core.assign(() => 0).hash).not.toBe(candidate.hash);
	}, 120_000);

	it("lets only one of two sessions decide a trial", () => {
		const dir = mkdtempSync(join(tmpdir(), "lattice-harness-"));
		dirs.push(dir);
		const first = open(dir);
		const second = open(dir);
		settle(first, "active", TRIAL.cooldownEpisodes, () => true);
		settle(first, "active", TRIAL.minEpisodes, (index) => index % 2 === 0);
		settle(second, "candidate", TRIAL.minEpisodes - 1, () => true);
		// The last candidate episode arrives in both sessions; each tries to decide.
		const a = settle(first, "candidate", 1, () => true);
		const b = second.step();
		expect([...a, ...(b ? [b] : [])].filter((decision) => decision.kind === "promoted")).toHaveLength(1);
		expect(first.active().status).toBe("canary");
		expect(second.active().version).toBe(first.active().version);
	});

	it("gates on drift and cost, and needs enough episodes", () => {
		const good = Array.from({ length: TRIAL.minEpisodes }, () => episode(true));
		const half = Array.from({ length: TRIAL.minEpisodes }, (_, index) => episode(index % 2 === 0));
		expect(trialGate(half.slice(1), good, 1, true).verdict).toBe("incomplete");
		expect(trialGate(half, good, 1, true).verdict).toBe("pass");
		const drifting = good.map((item, index) => (index === 0 ? { ...item, drift_actionable: 1 } : item));
		const gate = trialGate(half, drifting, 1, true);
		expect(gate.verdict).toBe("fail");
		expect(gate.reasons).toContain("drift rose");
		const cheaper = good.map((item) => ({ ...item, tokens: 500 }));
		const cost = trialGate(good, cheaper, 1, true);
		expect(cost.verdict).toBe("pass");
		expect(cost.route).toBe("cost");
		const pricier = good.map((item) => ({ ...item, tokens: 2000 }));
		expect(trialGate(half, pricier, 1, true).reasons.some((reason) => reason.startsWith("tokens rose"))).toBe(true);
		expect(trialGate(half, good, 1, false).reasons).toContain("parent is no longer active (stale trial)");
	});
});
