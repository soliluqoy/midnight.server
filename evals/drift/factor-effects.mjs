#!/usr/bin/env node
/**
 * Drift outcomes by factor for a factorial eval: silent drift, disclosure among failures, and
 * tokens per run, for each factor on versus off (averaged over the other factor), with a
 * one-sided Fisher exact test for the counts and a task-paired bootstrap for tokens.
 *
 * Usage: node evals/drift/factor-effects.mjs <results.jsonl> <factor> [<factor> ...]
 */
import { readFileSync } from "node:fs";

const [file, ...factors] = process.argv.slice(2);
if (!file || factors.length === 0) {
	console.error("Usage: node evals/drift/factor-effects.mjs <results.jsonl> <factor> [...]");
	process.exit(1);
}
const runs = readFileSync(file, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line))
	.filter((record) => record.assignment && factors.every((factor) => typeof record.assignment[factor] === "boolean"));

function logFactorial(n) {
	let sum = 0;
	for (let i = 2; i <= n; i++) sum += Math.log(i);
	return sum;
}

/** P(X <= a) for the top-left cell of a 2x2 table [[a, b], [c, d]] with fixed margins. */
function fisherLower(a, b, c, d) {
	const row1 = a + b;
	const col1 = a + c;
	const n = a + b + c + d;
	const p = (x) =>
		Math.exp(
			logFactorial(row1) +
				logFactorial(n - row1) +
				logFactorial(col1) +
				logFactorial(n - col1) -
				logFactorial(n) -
				logFactorial(x) -
				logFactorial(row1 - x) -
				logFactorial(col1 - x) -
				logFactorial(n - row1 - col1 + x),
		);
	let total = 0;
	for (let x = Math.max(0, row1 + col1 - n); x <= a; x++) total += p(x);
	return Math.min(1, total);
}

function seeded(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

const mean = (values) => (values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length);

for (const factor of factors) {
	const on = runs.filter((record) => record.assignment[factor]);
	const off = runs.filter((record) => !record.assignment[factor]);
	const silentOn = on.filter((record) => record.silentDrift).length;
	const silentOff = off.filter((record) => record.silentDrift).length;
	const failedOn = on.filter((record) => !record.artifactPassed);
	const failedOff = off.filter((record) => !record.artifactPassed);
	const disclosedOn = failedOn.filter((record) => record.disclosed).length;
	const disclosedOff = failedOff.filter((record) => record.disclosed).length;
	// Tokens: per task, mean(on) - mean(off); bootstrap over tasks.
	const tasks = [...new Set(runs.map((record) => record.task))];
	const perTask = tasks
		.map((task) => {
			const tokens = (list) => mean(list.filter((record) => record.task === task).map((record) => record.input + record.output));
			return tokens(on) - tokens(off);
		})
		.filter((value) => Number.isFinite(value));
	const random = seeded(7);
	const samples = [];
	for (let index = 0; index < 4000; index++) {
		let sum = 0;
		for (let draw = 0; draw < perTask.length; draw++) sum += perTask[Math.floor(random() * perTask.length)];
		samples.push(sum / perTask.length);
	}
	samples.sort((a, b) => a - b);
	const baseTokens = mean(off.map((record) => record.input + record.output));
	console.log(`== ${factor}  (on ${on.length} runs, off ${off.length} runs)`);
	console.log(
		`   silent drift: on ${silentOn}/${on.length}, off ${silentOff}/${off.length}; one-sided Fisher p(on <= off by chance) = ${fisherLower(silentOn, on.length - silentOn, silentOff, off.length - silentOff).toFixed(3)}`,
	);
	console.log(`   failed runs that disclosed a limitation: on ${disclosedOn}/${failedOn.length}, off ${disclosedOff}/${failedOff.length}`);
	console.log(
		`   tokens per run, on minus off (paired by task): ${mean(perTask).toFixed(0)} [${samples[100].toFixed(0)}, ${samples[3899].toFixed(0)}] (off mean ${baseTokens.toFixed(0)}, ${((100 * mean(perTask)) / baseTokens).toFixed(0)}%)`,
	);
}
