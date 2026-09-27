#!/usr/bin/env node

/**
 * Export harness-eval results to the normalized run schema of the sensitivity lab
 * (evals/sensitivity-lab/harness_lab.py `analyze`), for factorial effect and interaction analysis.
 *
 * Usage:
 *   node scripts/harness-eval-export.mjs --results <results.jsonl> --factors driftGuard,blockerExit --out <dir>
 *
 * Writes <dir>/runs.jsonl and <dir>/manifest.json. Only runs from a manifest experiment are
 * exported (they carry their full assignment). A run is refused when the harness's resolved
 * features differ from its assignment on a factor: an unverified treatment would be analysed as
 * the wrong arm. Arms outside the factorial (for example "bare") are left out and listed.
 *
 * Mapping (see the lab README): task_id = task; cluster_id = the task's `family`; artifact_passed =
 * the hidden grader alone; completed, timed_out, over_budget as recorded. A protected-file change
 * is not part of the lab's success definition, so runs with unchangedOk = false are exported with
 * artifact_passed = false and listed.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const value = argv[++index];
		if (value === undefined) throw new Error(`${arg} needs a value`);
		if (arg === "--results") options.results = path.resolve(value);
		else if (arg === "--factors") options.factors = value.split(",").filter(Boolean);
		else if (arg === "--out") options.out = path.resolve(value);
		else throw new Error(`Unknown option ${arg}`);
	}
	if (!options.results || !options.factors?.length || !options.out) {
		throw new Error("Usage: --results <file> --factors a,b --out <dir>");
	}
	return options;
}

export function exportRuns(records, factors) {
	const runs = [];
	const skipped = [];
	for (const record of records) {
		const assignment = record.assignment ?? {};
		if (!factors.every((factor) => typeof assignment[factor] === "boolean")) {
			skipped.push(`${record.task}/${record.variant}/${record.repeat}: not in the factorial`);
			continue;
		}
		const resolved = record.resolvedFeatures ?? {};
		const mismatch = factors.filter((factor) => resolved[factor] !== assignment[factor]);
		if (mismatch.length > 0) {
			throw new Error(
				`${record.task}/${record.variant}/${record.repeat}: resolved ${mismatch.map((factor) => `${factor}=${resolved[factor]}`).join(", ")} differs from the assignment`,
			);
		}
		if (record.unchangedOk === false) skipped.push(`${record.task}/${record.variant}/${record.repeat}: protected file changed (artifact_passed=false)`);
		runs.push({
			run_id: `${record.experimentId ?? "exp"}-${record.task}-${record.repeat}-${record.variant}`,
			task_id: record.task,
			cluster_id: record.family ?? record.task,
			repeat: record.repeat,
			factors: Object.fromEntries(factors.map((factor) => [factor, assignment[factor]])),
			artifact_passed: Boolean(record.artifactPassed) && record.unchangedOk !== false,
			completed: Boolean(record.completed),
			timed_out: Boolean(record.timedOut),
			over_budget: Boolean(record.overBudget),
		});
	}
	return { runs, skipped };
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const records = readFileSync(options.results, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const { runs, skipped } = exportRuns(records, options.factors);
	mkdirSync(options.out, { recursive: true });
	writeFileSync(path.join(options.out, "runs.jsonl"), `${runs.map((run) => JSON.stringify(run)).join("\n")}\n`);
	writeFileSync(path.join(options.out, "manifest.json"), `${JSON.stringify({ factors: options.factors })}\n`);
	console.log(`Exported ${runs.length} runs to ${options.out}`);
	for (const line of skipped) console.log(`  note: ${line}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
