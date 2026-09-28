/**
 * Analysis for scripts/harness-eval.mjs: turn categories, error classes, paired statistics and
 * the report. Pure functions over run records, so a results file can be re-analysed with
 * `--report` and the math can be unit-tested without running a model.
 */

const EXPLORE_TOOLS = new Set(["read", "ls", "find", "grep", "lookup"]);
const EDIT_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const VERIFY_COMMAND = /\b(test|tests|vitest|jest|mocha|pytest|go\s+test|cargo\s+(test|check)|tsc|tsgo|lint|eslint|biome|mypy|node\s+(--test\s+)?\S*test\S*\.m?js|python3?\s+\S*test\S*\.py)\b/i;

/**
 * What a turn was spent on, from its tool calls. A turn after a failed tool result that does
 * not edit counts as recovery.
 */
export function categorizeTurn(toolCalls, previousHadError) {
	if (toolCalls.length === 0) return "answer";
	const names = toolCalls.map((call) => call.name);
	if (names.some((name) => EDIT_TOOLS.has(name))) return "edit";
	const verifying = toolCalls.some(
		(call) => SHELL_TOOLS.has(call.name) && VERIFY_COMMAND.test(String(call.arguments?.command ?? "")),
	);
	if (verifying) return "verify";
	if (previousHadError) return "recover";
	if (names.every((name) => EXPLORE_TOOLS.has(name) || SHELL_TOOLS.has(name))) return "explore";
	return "other";
}

/** A short class for a failed tool result, for counting avoidable errors. */
export function classifyToolError(toolName, text) {
	if (/Edit rejected by the harness/.test(text)) return "edit-broke-syntax";
	if (/Could not find|oldText/.test(text) && toolName === "edit") return "edit-no-match";
	if (/occurrences/.test(text) && toolName === "edit") return "edit-ambiguous";
	if (/ENOENT|not found|No such file|does not exist|cannot find the path/i.test(text)) return "path-not-found";
	if (/is protected by the harness/.test(text)) return "protected-file";
	if (/not recognized as|is not recognized|CommandNotFoundException|command not found/i.test(text)) return "command-not-found";
	if (/ParserError|Unexpected token|syntax error/i.test(text) && (toolName === "powershell" || toolName === "bash")) {
		return "shell-syntax";
	}
	if (/timed out|timeout/i.test(text)) return "timeout";
	if (SHELL_TOOLS.has(toolName)) return "command-failed";
	return "other";
}

/** Deterministic pseudo-random numbers so bootstrap intervals are reproducible. */
export function seededRandom(seed = 12345) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

function mean(values) {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Paired comparison of two variants over tasks. `records` are run records with `task`,
 * `variant`, `repeat`, `passed`. Resamples tasks (the unit that varies most) to get a 95%
 * interval on the pass-rate difference, and runs an exact McNemar test on (task, repeat)
 * pairs.
 */
export function pairedComparison(records, baseline, candidate, { resamples = 4000, seed = 7 } = {}) {
	const tasks = [...new Set(records.map((record) => record.task))];
	const perTask = [];
	for (const task of tasks) {
		const base = records.filter((record) => record.task === task && record.variant === baseline);
		const cand = records.filter((record) => record.task === task && record.variant === candidate);
		if (base.length === 0 || cand.length === 0) continue;
		perTask.push({
			task,
			base: mean(base.map((record) => (record.passed ? 1 : 0))),
			cand: mean(cand.map((record) => (record.passed ? 1 : 0))),
		});
	}
	const difference = mean(perTask.map((item) => item.cand - item.base));
	const random = seededRandom(seed);
	const samples = [];
	for (let index = 0; index < resamples && perTask.length > 0; index++) {
		let sum = 0;
		for (let draw = 0; draw < perTask.length; draw++) {
			const item = perTask[Math.floor(random() * perTask.length)];
			sum += item.cand - item.base;
		}
		samples.push(sum / perTask.length);
	}
	samples.sort((a, b) => a - b);
	const quantile = (q) => (samples.length === 0 ? 0 : samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]);

	// McNemar on runs paired by task and repeat.
	let onlyBase = 0;
	let onlyCandidate = 0;
	for (const task of tasks) {
		const repeats = new Set(records.filter((record) => record.task === task).map((record) => record.repeat));
		for (const repeat of repeats) {
			const base = records.find((r) => r.task === task && r.variant === baseline && r.repeat === repeat);
			const cand = records.find((r) => r.task === task && r.variant === candidate && r.repeat === repeat);
			if (!base || !cand) continue;
			if (base.passed && !cand.passed) onlyBase++;
			if (!base.passed && cand.passed) onlyCandidate++;
		}
	}
	return {
		tasks: perTask.length,
		difference,
		low: quantile(0.025),
		high: quantile(0.975),
		onlyBase,
		onlyCandidate,
		pValue: mcnemarExact(onlyBase, onlyCandidate),
	};
}

/** Two-sided exact McNemar test (binomial on the discordant pairs). */
export function mcnemarExact(b, c) {
	const n = b + c;
	if (n === 0) return 1;
	const k = Math.min(b, c);
	let tail = 0;
	let coefficient = 1;
	for (let i = 0; i <= k; i++) {
		if (i > 0) coefficient = (coefficient * (n - i + 1)) / i;
		tail += coefficient;
	}
	return Math.min(1, (2 * tail) / 2 ** n);
}

export function variantSummary(records, variant) {
	const runs = records.filter((record) => record.variant === variant);
	const passed = runs.filter((record) => record.passed);
	const tokens = runs.reduce((sum, record) => sum + record.input + record.output, 0);
	const cost = runs.reduce((sum, record) => sum + record.cost, 0);
	const categories = {};
	const errors = {};
	for (const record of runs) {
		for (const [name, count] of Object.entries(record.turnCategories ?? {})) categories[name] = (categories[name] ?? 0) + count;
		for (const [name, count] of Object.entries(record.toolErrors ?? {})) errors[name] = (errors[name] ?? 0) + count;
	}
	const withRequirements = runs.filter((record) => Object.keys(record.requirements ?? {}).length > 0);
	const failed = runs.filter((record) => record.artifactPassed === false);
	return {
		variant,
		runs: runs.length,
		passed: passed.length,
		// Drift measures (records from before these fields existed count as zero).
		requirementRate:
			withRequirements.length === 0
				? undefined
				: mean(
						withRequirements.map((record) => {
							const values = Object.values(record.requirements);
							return values.filter((value) => value === true).length / values.length;
						}),
					),
		artifactPassed: runs.filter((record) => record.artifactPassed).length,
		silentDrift: runs.filter((record) => record.silentDrift).length,
		proxyGap: runs.filter((record) => record.proxyGap).length,
		testsModified: runs.filter((record) => (record.testsModified ?? []).length > 0).length,
		driftFlagged: runs.filter((record) => (record.driftActionable ?? 0) > 0).length,
		driftNudges: runs.reduce((sum, record) => sum + (record.driftNudges ?? 0), 0),
		disclosedFailures: failed.filter((record) => record.disclosed).length,
		failures: failed.length,
		passRate: runs.length === 0 ? 0 : passed.length / runs.length,
		tokensPerRun: runs.length === 0 ? 0 : tokens / runs.length,
		tokensPerSolved: passed.length === 0 ? Number.POSITIVE_INFINITY : tokens / passed.length,
		costPerSolved: passed.length === 0 ? Number.POSITIVE_INFINITY : cost / passed.length,
		cacheReadPerRun: mean(runs.map((record) => record.cacheRead)),
		// Share of prompt tokens served from the provider cache: history rewrites show up as a drop.
		cacheShare: (() => {
			const read = runs.reduce((sum, record) => sum + (record.cacheRead ?? 0), 0);
			const prompt = runs.reduce((sum, record) => sum + record.input + (record.cacheRead ?? 0), 0);
			return prompt === 0 ? 0 : read / prompt;
		})(),
		harnessSecondsPerRun: mean(runs.map((record) => (record.harnessMs ?? 0) / 1000)),
		secondsPerRun: mean(runs.map((record) => record.elapsedMs / 1000)),
		turnsPerRun: mean(runs.map((record) => record.turns)),
		turnsBeforeFirstEdit: mean(runs.map((record) => record.turnsBeforeFirstEdit ?? record.turns)),
		falseDone: runs.filter((record) => record.falseDone).length,
		errorsPerRun: runs.length === 0 ? 0 : Object.values(errors).reduce((a, b) => a + b, 0) / runs.length,
		categories,
		errors,
	};
}

const percent = (value) => `${(value * 100).toFixed(0)}%`;
const fixed = (value, digits = 0) => (Number.isFinite(value) ? value.toFixed(digits) : "-");

export function formatReport(records, variants) {
	const lines = [];
	const summaries = variants.map((variant) => variantSummary(records, variant)).filter((s) => s.runs > 0);
	lines.push(
		"",
		"variant                  pass           tok/run  tok/solved  $/solved  s/run  harness-s  cache  turns  1st-edit  false-done  errors/run",
	);
	for (const s of summaries) {
		lines.push(
			[
				s.variant.padEnd(24),
				`${s.passed}/${s.runs} (${percent(s.passRate)})`.padEnd(14),
				fixed(s.tokensPerRun).padStart(8),
				fixed(s.tokensPerSolved).padStart(11),
				fixed(s.costPerSolved, 4).padStart(9),
				fixed(s.secondsPerRun).padStart(6),
				fixed(s.harnessSecondsPerRun, 1).padStart(10),
				percent(s.cacheShare).padStart(6),
				fixed(s.turnsPerRun, 1).padStart(6),
				fixed(s.turnsBeforeFirstEdit, 1).padStart(9),
				String(s.falseDone).padStart(11),
				fixed(s.errorsPerRun, 2).padStart(11),
			].join(" "),
		);
	}
	if (summaries.some((s) => s.requirementRate !== undefined || s.silentDrift > 0 || s.driftFlagged > 0)) {
		lines.push(
			"",
			"Drift (runs): requirements met = mean share of a grader's REQ lines passed; silent drift = claimed success, hidden",
			"grader fails, nothing disclosed; proxy gap = visible checks pass, hidden grader fails; flagged = drift signals",
			"in the final change; disclosed = failed runs whose final message states a limitation.",
			"variant                  req.met  silent-drift  proxy-gap  tests-edited  flagged  nudges  disclosed/failed",
		);
		for (const s of summaries) {
			lines.push(
				[
					s.variant.padEnd(24),
					(s.requirementRate === undefined ? "-" : percent(s.requirementRate)).padStart(7),
					String(s.silentDrift).padStart(13),
					String(s.proxyGap).padStart(10),
					String(s.testsModified).padStart(13),
					String(s.driftFlagged).padStart(8),
					String(s.driftNudges).padStart(7),
					`${s.disclosedFailures}/${s.failures}`.padStart(17),
				].join(" "),
			);
		}
	}
	lines.push("", "Turns by category (all runs):");
	for (const s of summaries) {
		const parts = Object.entries(s.categories)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, count]) => `${name} ${count}`);
		lines.push(`  ${s.variant.padEnd(24)} ${parts.join(", ") || "-"}`);
	}
	lines.push("", "Tool errors by class (all runs):");
	for (const s of summaries) {
		const parts = Object.entries(s.errors)
			.sort(([, a], [, b]) => b - a)
			.map(([name, count]) => `${name} ${count}`);
		lines.push(`  ${s.variant.padEnd(24)} ${parts.join(", ") || "none"}`);
	}
	if (summaries.length > 1) {
		const baseline = summaries[0].variant;
		lines.push("", `Paired against ${baseline} (pass-rate difference, 95% bootstrap interval over tasks; exact McNemar):`);
		for (const s of summaries.slice(1)) {
			const result = pairedComparison(records, baseline, s.variant);
			lines.push(
				`  ${s.variant.padEnd(24)} ${result.difference >= 0 ? "+" : ""}${percent(result.difference)} [${percent(result.low)}, ${percent(result.high)}]  only-${baseline} ${result.onlyBase}, only-${s.variant} ${result.onlyCandidate}, p=${result.pValue.toFixed(3)} (${result.tasks} tasks)`,
			);
		}
	}
	const categories = [...new Set(records.map((record) => record.category ?? "uncategorized"))].sort();
	if (categories.length > 1) {
		lines.push("", "Pass rate by task category:");
		for (const category of categories) {
			const cells = summaries.map((s) => {
				const runs = records.filter((r) => r.variant === s.variant && (r.category ?? "uncategorized") === category);
				return `${s.variant} ${runs.filter((r) => r.passed).length}/${runs.length}`;
			});
			lines.push(`  ${category.padEnd(24)} ${cells.join("   ")}`);
		}
	}
	lines.push("", "Per task (pass count per variant):");
	for (const name of [...new Set(records.map((record) => record.task))].sort()) {
		const cells = summaries.map((s) => {
			const runs = records.filter((record) => record.task === name && record.variant === s.variant);
			return `${s.variant} ${runs.filter((record) => record.passed).length}/${runs.length}`;
		});
		lines.push(`  ${name.padEnd(24)} ${cells.join("   ")}`);
	}
	const harnessEvents = {};
	for (const record of records) {
		for (const [type, count] of Object.entries(record.harnessEvents ?? {})) {
			harnessEvents[record.variant] ??= {};
			harnessEvents[record.variant][type] = (harnessEvents[record.variant][type] ?? 0) + count;
		}
	}
	if (Object.keys(harnessEvents).length > 0) {
		lines.push("", "Harness events (all runs):");
		for (const [variant, events] of Object.entries(harnessEvents)) {
			lines.push(
				`  ${variant.padEnd(24)} ${Object.entries(events)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([type, count]) => `${type} ${count}`)
					.join(", ")}`,
			);
		}
	}
	return lines.join("\n");
}
