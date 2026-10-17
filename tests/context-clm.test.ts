import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetPolicyFromEnv, budgetTiers, resolveBudgetPolicy } from "../src/context/budget.ts";
import { observationCapFromEnv } from "../src/context/observation.ts";
import {
	applyOverflowGuard,
	overflowNoticeText,
	overflowUnavailableNotice,
	shouldReportUnavailable,
} from "../src/context/overflow.ts";
import { formatTokens, parseReminders, parseTokenCount } from "../src/context/tokens.ts";
import type { LiveContextMessage } from "../src/context/types.ts";

const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;

test("parseTokenCount accepts the forms /clm config advertises", () => {
	assert.equal(parseTokenCount("200k"), 200000);
	assert.equal(parseTokenCount("2k"), 2000);
	assert.equal(parseTokenCount("1.5m"), 1500000);
	assert.equal(parseTokenCount("1_000"), 1000);
	assert.equal(parseTokenCount("2048"), 2048);
	assert.equal(parseTokenCount("2000"), 2000);
	assert.equal(formatTokens(2000), "2k");
});

test("parseTokenCount still rejects genuinely invalid input", () => {
	assert.throws(() => parseTokenCount("many"), /expected a number of tokens like 200k/);
	assert.throws(() => parseTokenCount("10k:0.5"), /expected a number of tokens like 200k/);
});

test("parseReminders accepts slash, comma, fraction, percent and off forms", () => {
	assert.deepEqual(parseReminders("50/75/90"), [0.5, 0.75, 0.9]);
	assert.deepEqual(parseReminders("50,75,90"), [0.5, 0.75, 0.9]);
	assert.deepEqual(parseReminders("0.5,0.75,0.9"), [0.5, 0.75, 0.9]);
	assert.deepEqual(parseReminders("50%"), [0.5]);
	assert.deepEqual(parseReminders("off"), []);
	assert.deepEqual(parseReminders("none"), []);
	assert.throws(() => parseReminders("soon"), /reminders must be percentages like 50\/75\/90/);
});

test("budgetPolicyFromEnv accepts the advertised env forms", () => {
	const parsed = budgetPolicyFromEnv(
		env({ PI_CLM_BUDGET: "200k", PI_CLM_RESERVE: "2k", PI_CLM_REMIND_AT: "50/75/90" }),
	);
	assert.equal(parsed.contextBudget, 200000);
	assert.equal(parsed.reserve, 2000);
	assert.deepEqual(parsed.remindAtFractions, [0.5, 0.75, 0.9]);
	assert.equal(parsed.remindAtReserve, undefined);

	const live = budgetPolicyFromEnv(env({ PI_CLM_REMIND_AT: "0.5,0.75,0.9" }));
	assert.deepEqual(live.remindAtFractions, [0.5, 0.75, 0.9]);
	assert.equal(live.remindAtReserve, undefined);

	const off = budgetPolicyFromEnv(env({ PI_CLM_REMIND_AT: "off" }));
	assert.deepEqual(off.remindAtFractions, []);
	assert.equal(off.remindAtReserve, false);

	const none = budgetPolicyFromEnv(env({ PI_CLM_REMIND_AT: "none" }));
	assert.deepEqual(none.remindAtFractions, []);
	assert.equal(none.remindAtReserve, false);

	// Disabling reminders must not be case-sensitive: `parseReminders` accepts "OFF", so the reserve reminder
	// has to be disabled too instead of staying enabled by default.
	for (const offForm of ["OFF", "Off", "NONE", " oFF "]) {
		const disabled = budgetPolicyFromEnv(env({ PI_CLM_REMIND_AT: offForm }));
		assert.deepEqual(disabled.remindAtFractions, [], offForm);
		assert.equal(disabled.remindAtReserve, false, offForm);
	}

	for (const onForm of ["50/75/90", "0.5,0.75,0.9", "50%"]) {
		const enabled = budgetPolicyFromEnv(env({ PI_CLM_REMIND_AT: onForm }));
		assert.ok((enabled.remindAtFractions ?? []).length > 0, onForm);
		assert.equal(enabled.remindAtReserve, undefined, onForm);
	}

	// The override alone is not the contract: an off form has to reach resolveBudgetPolicy/budgetTiers and leave
	// no reminder tier at all, while the default policy still carries its budget-minus-reserve tier.
	for (const offForm of ["off", "OFF", "none", "NONE"]) {
		const policy = resolveBudgetPolicy(budgetPolicyFromEnv(env({ PI_CLM_REMIND_AT: offForm })));
		assert.deepEqual(budgetTiers(policy, 200000, 2048), [], offForm);
	}
	const defaults = budgetTiers(resolveBudgetPolicy(undefined), 200000, 2048);
	assert.ok(
		defaults.some((tier) => tier.label === "budget-reserve"),
		"the default policy still keeps the reserve reminder",
	);

	assert.throws(() => budgetPolicyFromEnv(env({ PI_CLM_BUDGET: "many" })), /expected a number of tokens like 200k/);
});

test("observationCapFromEnv parses the 10k:0.5 form and keeps its errors", () => {
	assert.deepEqual(observationCapFromEnv(env({ PI_CLM_OBSERVATION_CAP: "10k:0.5" })), {
		maxCharacters: 10000,
		headFraction: 0.5,
	});
	assert.deepEqual(observationCapFromEnv(env({ PI_CLM_OBSERVATION_CAP: "5k" })), { maxCharacters: 5000 });
	assert.deepEqual(observationCapFromEnv(env({ PI_CLM_OBSERVATION_CAP: "off" })), {});
	assert.deepEqual(observationCapFromEnv(env({ PI_CLM_OBSERVATION_CAP: "0" })), {});
	assert.throws(
		() => observationCapFromEnv(env({ PI_CLM_OBSERVATION_CAP: "10k:2" })),
		/head fraction must be in \(0, 1\]/,
	);
	assert.throws(
		() => observationCapFromEnv(env({ PI_CLM_OBSERVATION_CAP: "many" })),
		/PI_CLM_OBSERVATION_CAP must be a positive number of characters/,
	);
});

const userMessage = (): LiveContextMessage => ({ role: "user", content: "hello" });
const toolResultMessage = (id: string): LiveContextMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text: "x".repeat(400) }],
});
const estimateByRole = (messages: LiveContextMessage[]): number =>
	messages.reduce((sum, message) => sum + (message.role === "toolResult" ? 100 : 10), 0);

test("overflowUnavailableNotice covers an over-limit request with no eligible tool result", () => {
	const limit = 100;
	const guarded = applyOverflowGuard([userMessage()], { limit, fixedTokens: 150, estimate: estimateByRole });
	// Mirrors the call-site gate in src/context/index.ts: shouldReportUnavailable(guarded, limit).
	assert.equal(shouldReportUnavailable(guarded, limit), true);
	const notice = overflowUnavailableNotice(guarded.estimated, limit);
	assert.match(notice, /exceeds the limit of 100 tokens/);
	assert.match(notice, /no eligible tool result to withhold/);
	assert.match(notice, /full request will be sent/);
	assert.match(notice, /Free space in your context now/);
});

test("shouldReportUnavailable pins the limit boundary in both directions", () => {
	const limit = 100;
	// estimateByRole(userMessage()) is 10 tokens, so fixedTokens 90 lands exactly on the limit.
	const atLimit = applyOverflowGuard([userMessage()], { limit, fixedTokens: 90, estimate: estimateByRole });
	assert.equal(atLimit.estimated, limit);
	assert.equal(shouldReportUnavailable(atLimit, limit), false);

	const overLimit = applyOverflowGuard([userMessage()], { limit, fixedTokens: 91, estimate: estimateByRole });
	assert.equal(overLimit.estimated, limit + 1);
	assert.equal(shouldReportUnavailable(overLimit, limit), true);
});

test("the unavailable notice is not produced within budget or when results were withheld", () => {
	const limit = 100;
	const withinBudget = applyOverflowGuard([userMessage()], { limit, fixedTokens: 50, estimate: estimateByRole });
	assert.equal(shouldReportUnavailable(withinBudget, limit), false);

	const withheld = applyOverflowGuard([toolResultMessage("t1")], {
		limit: 50,
		fixedTokens: 0,
		estimate: estimateByRole,
	});
	assert.ok(withheld.withheld.length > 0);
	assert.equal(shouldReportUnavailable(withheld, 50), false);
	assert.match(overflowNoticeText(withheld, 50), /withheld from your context/);
});
