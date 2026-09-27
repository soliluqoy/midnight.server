#!/usr/bin/env node

/**
 * Validate the harness eval tasks without running any model:
 *
 * - the starting workspace fails the hidden grader (otherwise the task measures nothing),
 * - the reference solution passes the hidden grader and the task's visible checks,
 * - the reference solution leaves every `unchanged` file untouched,
 * - task.json has the fields the runner and the report need.
 *
 * Tasks whose `requires` names a command that is not on PATH are skipped, not failed.
 *
 * Usage: node scripts/harness-eval-validate.mjs [--tasks <dir>] [--only a,b]
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasCommand, portableArgv } from "./harness-eval-commands.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATEGORIES = new Set([
	"sanity",
	"implied-requirements",
	"underspecified-standard",
	"hidden-bug",
	"test-trap",
	"multi-file",
	"navigation",
	"refactor",
	"feature",
	"environment",
]);

function parseArgs(argv) {
	const options = { tasks: path.join(repoRoot, "evals", "harness", "tasks"), only: undefined };
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] === "--tasks") options.tasks = path.resolve(argv[++index]);
		else if (argv[index] === "--only") options.only = argv[++index].split(",");
		else throw new Error(`Unknown option ${argv[index]}`);
	}
	return options;
}

function run(taskArgv, cwd) {
	const argv = portableArgv(taskArgv);
	const result = spawnSync(argv[0], argv.slice(1), {
		cwd,
		encoding: "utf8",
		timeout: 120_000,
		env: { ...process.env, CI: "1" },
		shell: process.platform === "win32",
	});
	return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function workspace(taskRoot, withReference, referenceRoot) {
	const dir = mkdtempSync(path.join(tmpdir(), "harness-validate-"));
	cpSync(path.join(taskRoot, "files"), dir, { recursive: true });
	if (withReference) cpSync(referenceRoot, dir, { recursive: true });
	return dir;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const names = readdirSync(options.tasks, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && (!options.only || options.only.includes(entry.name)))
		.map((entry) => entry.name)
		.sort();
	let failures = 0;
	let skipped = 0;
	for (const name of names) {
		const taskRoot = path.join(options.tasks, name);
		const referenceRoot = path.join(options.tasks, "..", "reference", name);
		const spec = JSON.parse(readFileSync(path.join(taskRoot, "task.json"), "utf8"));
		const problems = [];
		const missing = (spec.requires ?? []).filter((command) => !hasCommand(command));
		if (missing.length > 0) {
			console.log(`SKIP  ${name} (needs ${missing.join(", ")})`);
			skipped++;
			continue;
		}
		if (!CATEGORIES.has(spec.category)) problems.push(`unknown category ${spec.category}`);
		if (spec.split !== "dev" && spec.split !== "holdout") problems.push(`split must be dev or holdout`);
		if (!Array.isArray(spec.grade)) problems.push("grade must be an argv array");
		if (!existsSync(path.join(taskRoot, "prompt.txt"))) problems.push("missing prompt.txt");
		if (!existsSync(referenceRoot)) problems.push("missing reference solution");

		if (problems.length === 0) {
			const start = workspace(taskRoot, false);
			cpSync(path.join(taskRoot, "hidden"), start, { recursive: true });
			if (run(spec.grade, start).ok) problems.push("the starting workspace already passes the grader");
			rmSync(start, { recursive: true, force: true });

			const solved = workspace(taskRoot, true, referenceRoot);
			for (const check of spec.checks ?? []) {
				const result = run(check.command, solved);
				if (!result.ok) problems.push(`reference fails visible check ${check.name}: ${result.output.slice(0, 300)}`);
			}
			for (const file of spec.unchanged ?? []) {
				const original = readFileSync(path.join(taskRoot, "files", file));
				if (!original.equals(readFileSync(path.join(solved, file)))) problems.push(`reference changes ${file}`);
			}
			cpSync(path.join(taskRoot, "hidden"), solved, { recursive: true });
			const graded = run(spec.grade, solved);
			if (!graded.ok) problems.push(`reference fails the grader: ${graded.output.slice(0, 400)}`);
			rmSync(solved, { recursive: true, force: true });
		}

		if (problems.length > 0) {
			failures++;
			console.log(`FAIL  ${name}\n      ${problems.join("\n      ")}`);
		} else console.log(`ok    ${name} (${spec.category}, ${spec.split})`);
	}
	console.log(`\n${names.length - failures - skipped} valid, ${failures} invalid, ${skipped} skipped`);
	if (failures > 0) process.exit(1);
}

main();
