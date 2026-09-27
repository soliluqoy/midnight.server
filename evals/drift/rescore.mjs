#!/usr/bin/env node
/**
 * Re-score the drift detectors on real runs: every `<run>.changes.json` saved by
 * scripts/harness-eval.mjs holds the request, the final message and the final change. This runs
 * the current detectors on them and compares with the hidden grader's verdict in the results
 * file, so detector changes can be judged on real agent output, not only synthetic variants.
 *
 * A signal on a run whose hidden grader passed is a false alarm unless the run really drifted in a
 * way the grader does not test (it is listed for reading). A failed run with no signal is drift
 * the detectors cannot see (most failures are plain bugs, which is expected).
 *
 * Usage: node evals/drift/rescore.mjs <results.jsonl> [more.jsonl ...]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const drift = await import(pathToFileURL(path.join(repo, "packages/coding-agent/src/harness/drift.ts")).href);
const { isTestPath } = await import(pathToFileURL(path.join(repo, "packages/coding-agent/src/harness/workspace-index.ts")).href);

function listFiles(root, base = root) {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(root, entry.name);
		return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join("/")];
	});
}

const taskCache = new Map();
function taskFiles(task) {
	if (!taskCache.has(task)) {
		const root = path.join(repo, "evals/harness/tasks", task, "files");
		taskCache.set(task, new Map(listFiles(root).map((file) => [file, readFileSync(path.join(root, file), "utf8")])));
	}
	return taskCache.get(task);
}

const files = process.argv.slice(2);
if (files.length === 0) {
	console.error("Usage: node evals/drift/rescore.mjs <results.jsonl> [...]");
	process.exit(1);
}
let runs = 0;
const alarms = [];
const caught = [];
const unseen = [];
for (const file of files) {
	for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
		const record = JSON.parse(line);
		const changesPath = record.events?.replace(/\.jsonl$/, ".changes.json");
		if (!changesPath || !existsSync(changesPath)) continue;
		const saved = JSON.parse(readFileSync(changesPath, "utf8"));
		// The task's own starting files: unchanged test files are where a special case copies from.
		const startFiles = taskFiles(record.task);
		const signals = drift.actionable(
			drift.detectDrift({
				request: saved.request,
				changes: saved.changes,
				finalMessage: saved.finalMessage,
				verification: { verifiedAfterLastChange: true, lastCheckFailed: !record.visiblePassed },
				testSources: new Map([...startFiles].filter(([name]) => isTestPath(name))),
				workspaceFiles: [...startFiles.keys()],
				shellCommands: saved.shellCommands ?? [],
			}),
		);
		runs++;
		const label = `${record.task} ${record.variant} #${record.repeat}`;
		const kinds = signals.map((signal) => `${signal.kind}: ${signal.evidence}`).join("; ");
		if (record.artifactPassed && signals.length > 0) alarms.push(`${label}: ${kinds}`);
		else if (!record.artifactPassed && signals.length > 0) caught.push(`${label}: ${kinds}`);
		else if (!record.artifactPassed) unseen.push(`${label}: ${record.reason?.slice(0, 120)}`);
	}
}
console.log(`${runs} runs with saved changes`);
console.log(`\nSignals on runs the hidden grader passed (${alarms.length}; read each: false alarm or ungraded drift):`);
for (const line of alarms) console.log(`  ${line}`);
console.log(`\nSignals on failed runs (${caught.length}):`);
for (const line of caught) console.log(`  ${line}`);
console.log(`\nFailed runs with no signal (${unseen.length}):`);
for (const line of unseen) console.log(`  ${line}`);
