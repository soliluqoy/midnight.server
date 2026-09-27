#!/usr/bin/env node

/**
 * Measure what the harness does for a model: run the same tasks with the harness on, off and
 * in ablated variants, grade each run with hidden tests the agent never sees, and report pass
 * rate, tokens per solved task, turns by category, avoidable tool errors and false "done"
 * claims, with paired statistics between variants.
 *
 * Usage:
 *   node scripts/harness-eval.mjs [options] -- <agent args>
 *   node scripts/harness-eval.mjs --repeat 5 --split dev -- --model openai-codex/gpt-6-luna
 *   node scripts/harness-eval.mjs --variants bare,harness,no-pack=-contextPack -- --model deepseek/deepseek-v4.1-flash
 *   node scripts/harness-eval.mjs --report evals/harness/results/<file>.jsonl
 *
 * Options:
 *   --tasks <dir>       Task directory (default evals/harness/tasks)
 *   --only <a,b>        Run only these tasks
 *   --split <s>         dev | holdout | all (default all). Tune on dev; judge on holdout.
 *   --variants <list>   Comma list. "bare" turns the harness off, "harness" is the default
 *                       harness, and name=+feat,-feat is the harness with feature switches
 *                       (MIDNIGHT_SERVER_HARNESS_FEATURES), e.g. no-pack=-contextPack.
 *                       Default: bare,harness. The first variant is the baseline.
 *   --checks <mode>     config: write the task's checks to harness.json (default).
 *                       detect: write only protected files; the harness detects checks itself.
 *   --repeat <n>        Runs per task and variant (default 1)
 *   --jobs <n>          Runs in parallel (default 1). Keep 1 for the local model.
 *   --timeout <s>       Per-run timeout in seconds (default 1800)
 *   --max-cost <usd>    Stop a run whose reported cost passes this; it counts as a failure.
 *   --out <file>        JSONL results (default evals/harness/results/<timestamp>.jsonl)
 *   --keep              Keep each run's workspace for inspection
 *   --report <file>     Only print the report for an existing results file
 *
 * Each run's JSON event stream is saved next to the results as <out>.events/<task>-<variant>-<n>.jsonl,
 * and the harness's own decisions as ...telemetry.jsonl.
 *
 * A task is a directory with:
 *   prompt.txt   what the agent is asked
 *   files/       the starting workspace (committed to a fresh git repo)
 *   hidden/      grading files, copied in only after the agent exits
 *   task.json    { "category", "split", "grade": argv, "checks": [...], "protect": [...],
 *                  "unchanged": [...], "requires": [commands] }
 *                `unchanged` files must be byte-identical after the run, or it fails.
 * `node scripts/harness-eval-validate.mjs` checks every task without running a model.
 *
 * Runs use the source CLI (tsx) with --approve, --no-session and --mode json. Agent args after
 * `--` choose the model. Real providers cost real tokens.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasCommand, portableArgv } from "./harness-eval-commands.mjs";
import { categorizeTurn, classifyToolError, formatReport } from "./harness-eval-stats.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseVariant(text) {
	const [name, features] = text.split("=");
	if (name === "bare") return { name, harness: false };
	return { name, harness: true, features: features ?? (name === "harness" ? "" : undefined) };
}

function parseArgs(argv) {
	const split = argv.indexOf("--");
	const own = split === -1 ? argv : argv.slice(0, split);
	const options = {
		tasks: path.join(repoRoot, "evals", "harness", "tasks"),
		only: undefined,
		split: "all",
		variants: [parseVariant("bare"), parseVariant("harness")],
		checks: "config",
		repeat: 1,
		jobs: 1,
		timeoutMs: 1_800_000,
		maxCost: undefined,
		out: undefined,
		keep: false,
		report: undefined,
		agentArgs: split === -1 ? [] : argv.slice(split + 1),
	};
	for (let index = 0; index < own.length; index++) {
		const arg = own[index];
		const next = () => {
			const value = own[++index];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			return value;
		};
		if (arg === "--tasks") options.tasks = path.resolve(next());
		else if (arg === "--only") options.only = next().split(",");
		else if (arg === "--split") options.split = next();
		else if (arg === "--variants") options.variants = next().split(",").map(parseVariant);
		else if (arg === "--checks") options.checks = next();
		else if (arg === "--repeat") options.repeat = Number(next());
		else if (arg === "--jobs") options.jobs = Number(next());
		else if (arg === "--timeout") options.timeoutMs = Number(next()) * 1000;
		else if (arg === "--max-cost") options.maxCost = Number(next());
		else if (arg === "--out") options.out = path.resolve(next());
		else if (arg === "--keep") options.keep = true;
		else if (arg === "--report") options.report = path.resolve(next());
		else throw new Error(`Unknown option ${arg}`);
	}
	for (const variant of options.variants) {
		if (variant.harness && variant.features === undefined) {
			throw new Error(`Variant ${variant.name}: use bare, harness, or name=+feature,-feature`);
		}
	}
	if (!["all", "dev", "holdout"].includes(options.split)) throw new Error("--split must be all, dev or holdout");
	if (!["config", "detect"].includes(options.checks)) throw new Error("--checks must be config or detect");
	if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error("--repeat must be a positive integer");
	if (!Number.isInteger(options.jobs) || options.jobs < 1) throw new Error("--jobs must be a positive integer");
	return options;
}

function loadTasks(dir, only, split) {
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && (!only || only.includes(entry.name)))
		.map((entry) => {
			const root = path.join(dir, entry.name);
			return {
				name: entry.name,
				root,
				prompt: readFileSync(path.join(root, "prompt.txt"), "utf8").trim(),
				spec: JSON.parse(readFileSync(path.join(root, "task.json"), "utf8")),
			};
		})
		.filter((task) => split === "all" || task.spec.split === split)
		.filter((task) => {
			const missing = (task.spec.requires ?? []).filter((command) => !hasCommand(command));
			if (missing.length > 0) console.log(`skip ${task.name}: needs ${missing.join(", ")}`);
			return missing.length === 0;
		});
}

function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function sha256(file) {
	return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "missing";
}

function prepareWorkspace(task, variant, checksMode) {
	const cwd = mkdtempSync(path.join(tmpdir(), `harness-eval-${task.name}-`));
	cpSync(path.join(task.root, "files"), cwd, { recursive: true });
	git(cwd, ["init", "-q"]);
	git(cwd, ["add", "-A"]);
	git(cwd, ["-c", "user.email=eval@example.com", "-c", "user.name=eval", "commit", "-qm", "start"]);
	if (variant.harness) {
		mkdirSync(path.join(cwd, ".midnight.server"), { recursive: true });
		const config = { checks:
				checksMode === "config"
					? (task.spec.checks ?? []).map((check) => ({ ...check, command: portableArgv(check.command) }))
					: [], protect: task.spec.protect ?? [] };
		writeFileSync(path.join(cwd, ".midnight.server", "harness.json"), JSON.stringify(config, null, "\t"));
	}
	return cwd;
}

function textOf(content) {
	return (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** Run the agent and collect what its JSON event stream says about the run. */
function runAgent(cwd, prompt, variant, options, eventsPath, telemetryPath) {
	const cli = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
	const tsx = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
	const args = [
		tsx,
		"--tsconfig",
		path.join(repoRoot, "tsconfig.json"),
		cli,
		"--approve",
		"--no-session",
		"--mode",
		"json",
		...options.agentArgs,
		"-p",
		prompt,
	];
	const env = { ...process.env };
	delete env.MIDNIGHT_SERVER_HARNESS_FEATURES;
	if (!variant.harness) env.MIDNIGHT_SERVER_HARNESS = "0";
	else {
		delete env.MIDNIGHT_SERVER_HARNESS;
		if (variant.features) env.MIDNIGHT_SERVER_HARNESS_FEATURES = variant.features;
		env.MIDNIGHT_SERVER_HARNESS_TELEMETRY = telemetryPath;
	}
	const stats = {
		turns: 0,
		toolCalls: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		harnessChecks: 0,
		contractReminders: 0,
		advice: 0,
		turnCategories: {},
		toolErrors: {},
		turnsBeforeFirstEdit: undefined,
		perTurn: [],
		lastStopReason: undefined,
		lastText: "",
		exitCode: null,
		timedOut: false,
		overBudget: false,
		stderrTail: "",
	};
	let previousHadError = false;
	let pendingErrors = false;
	return new Promise((resolve) => {
		const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let buffer = "";
		let stderr = "";
		const onLine = (line) => {
			if (line.trim()) writeFileSync(eventsPath, `${line}\n`, { flag: "a" });
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type !== "message_end") return;
			const message = event.message;
			if (message.role === "assistant") {
				stats.turns++;
				const calls = message.content.filter((part) => part.type === "toolCall");
				stats.toolCalls += calls.length;
				const category = categorizeTurn(calls, previousHadError);
				stats.turnCategories[category] = (stats.turnCategories[category] ?? 0) + 1;
				if (category === "edit" && stats.turnsBeforeFirstEdit === undefined) stats.turnsBeforeFirstEdit = stats.turns - 1;
				previousHadError = false;
				pendingErrors = false;
				const usage = message.usage ?? {};
				stats.input += usage.input ?? 0;
				stats.output += usage.output ?? 0;
				stats.cacheRead += usage.cacheRead ?? 0;
				stats.cacheWrite += usage.cacheWrite ?? 0;
				stats.cost += usage.cost?.total ?? 0;
				stats.perTurn.push({ input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, category });
				stats.lastStopReason = message.stopReason;
				const text = textOf(message.content).trim();
				if (text) stats.lastText = text.slice(0, 2000);
				if (options.maxCost !== undefined && stats.cost > options.maxCost && !stats.overBudget) {
					stats.overBudget = true;
					child.kill();
				}
			} else if (message.role === "toolResult") {
				if (message.isError) {
					const kind = classifyToolError(message.toolName, textOf(message.content));
					stats.toolErrors[kind] = (stats.toolErrors[kind] ?? 0) + 1;
					pendingErrors = true;
				}
				previousHadError = pendingErrors;
			} else if (message.role === "custom") {
				if (message.customType === "harness_check") stats.harnessChecks++;
				if (message.customType === "harness_contract") stats.contractReminders++;
				if (message.customType === "harness_advice") stats.advice++;
			}
		};
		child.stdout.on("data", (data) => {
			buffer += data.toString();
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				onLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
		});
		child.stderr.on("data", (data) => {
			stderr = (stderr + data.toString()).slice(-2000);
		});
		const timer = setTimeout(() => {
			stats.timedOut = true;
			child.kill();
		}, options.timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (buffer) onLine(buffer);
			stats.exitCode = code;
			stats.stderrTail = stderr.trim().split("\n").slice(-3).join("\n");
			resolve(stats);
		});
	});
}

function readTelemetry(file) {
	if (!existsSync(file)) return {};
	const counts = {};
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			counts[event.type] = (counts[event.type] ?? 0) + 1;
		} catch {
			// Ignore a partial last line.
		}
	}
	return counts;
}

function grade(task, cwd, originalHashes) {
	for (const [file, hash] of Object.entries(originalHashes)) {
		if (sha256(path.join(cwd, file)) !== hash) return { passed: false, reason: `${file} was changed` };
	}
	cpSync(path.join(task.root, "hidden"), cwd, { recursive: true });
	const [command, ...args] = portableArgv(task.spec.grade);
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		timeout: 120_000,
		shell: process.platform === "win32",
		env: { ...process.env, CI: "1" },
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	return {
		passed: result.status === 0,
		reason: result.status === 0 ? "hidden tests pass" : output.split("\n").slice(0, 3).join(" | ").slice(0, 300),
	};
}

async function runPool(jobs, concurrency) {
	const results = [];
	let next = 0;
	const worker = async () => {
		while (next < jobs.length) {
			const index = next++;
			results[index] = await jobs[index]();
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
	return results;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.report) {
		const records = readFileSync(options.report, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const variants = [...new Set(records.map((record) => record.variant))];
		console.log(formatReport(records, variants));
		return;
	}
	const tasks = loadTasks(options.tasks, options.only, options.split);
	if (tasks.length === 0) throw new Error(`No tasks in ${options.tasks} for split ${options.split}`);
	const out =
		options.out ??
		path.join(repoRoot, "evals", "harness", "results", `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
	mkdirSync(path.dirname(out), { recursive: true });
	// One JSON event stream per run, for reading trajectories after the fact.
	const eventsDir = `${out.replace(/\.jsonl$/, "")}.events`;
	mkdirSync(eventsDir, { recursive: true });
	console.log(`Agent args: ${options.agentArgs.join(" ") || "(configured default model)"}`);
	console.log(
		`Tasks (${tasks.length}, split ${options.split}): ${tasks.map((task) => task.name).join(", ")}\nVariants: ${options.variants.map((variant) => variant.name).join(", ")}; checks ${options.checks}; repeat ${options.repeat}; jobs ${options.jobs}`,
	);
	const jobs = [];
	for (let repeat = 0; repeat < options.repeat; repeat++) {
		for (const task of tasks) {
			// Alternate variant order per repeat so a warm cache or engine does not favor one side.
			const order = repeat % 2 === 0 ? options.variants : [...options.variants].reverse();
			for (const variant of order) {
				jobs.push(async () => {
					const cwd = prepareWorkspace(task, variant, options.checks);
					const originalHashes = Object.fromEntries(
						(task.spec.unchanged ?? []).map((file) => [file, sha256(path.join(cwd, file))]),
					);
					const started = Date.now();
					const stem = path.join(eventsDir, `${task.name}-${variant.name}-${repeat}`);
					const stats = await runAgent(cwd, task.prompt, variant, options, `${stem}.jsonl`, `${stem}.telemetry.jsonl`);
					const elapsedMs = Date.now() - started;
					const verdict = stats.overBudget
						? { passed: false, reason: `over the $${options.maxCost} budget` }
						: grade(task, cwd, originalHashes);
					const record = {
						task: task.name,
						category: task.spec.category,
						split: task.spec.split,
						variant: variant.name,
						features: variant.harness ? variant.features || "(default)" : "off",
						repeat,
						elapsedMs,
						...stats,
						...verdict,
						// Ended normally, said it was done, and the hidden tests fail.
						falseDone: !verdict.passed && !stats.timedOut && !stats.overBudget && stats.lastStopReason === "stop",
						harnessEvents: readTelemetry(`${stem}.telemetry.jsonl`),
						events: `${stem}.jsonl`,
						workspace: options.keep ? cwd : undefined,
					};
					writeFileSync(out, `${JSON.stringify(record)}\n`, { flag: "a" });
					console.log(
						`${verdict.passed ? "PASS" : "FAIL"}  ${task.name.padEnd(20)} ${variant.name.padEnd(12)} ${(elapsedMs / 1000).toFixed(0)}s  ${stats.input + stats.output} tok  ${stats.turns} turns  ${verdict.reason}${stats.timedOut ? " (timed out)" : ""}`,
					);
					if (!options.keep) rmSync(cwd, { recursive: true, force: true });
					return record;
				});
			}
		}
	}
	const records = await runPool(jobs, options.jobs);
	console.log(
		formatReport(
			records,
			options.variants.map((variant) => variant.name),
		),
	);
	console.log(`\nResults: ${out}\nRe-print this report: node scripts/harness-eval.mjs --report ${path.relative(repoRoot, out)}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
