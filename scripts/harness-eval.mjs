#!/usr/bin/env node

/**
 * Measure what the harness does for a model: run the same tasks with the harness on and off,
 * grade each run with hidden tests the agent never sees, and report pass rate, tokens, cost
 * and time per variant.
 *
 * Usage:
 *   node scripts/harness-eval.mjs [options] -- <agent args>
 *   node scripts/harness-eval.mjs --repeat 3 -- --local
 *   node scripts/harness-eval.mjs --only port-intent,csv-quotes -- --model anthropic/claude-sonnet-5
 *
 * Options:
 *   --tasks <dir>       Task directory (default evals/harness/tasks)
 *   --only <a,b>        Run only these tasks
 *   --variants <list>   harness,bare (default both)
 *   --repeat <n>        Runs per task and variant (default 1)
 *   --timeout <s>       Per-run timeout in seconds (default 1800)
 *   --out <file>        JSONL results (default evals/harness/results/<timestamp>.jsonl)
 *   --keep              Keep each run's workspace for inspection
 *
 * Each run's JSON event stream is saved next to the results as <out>.events/<task>-<variant>-<n>.jsonl.
 *
 * A task is a directory with:
 *   prompt.txt   what the agent is asked
 *   files/       the starting workspace (committed to a fresh git repo)
 *   hidden/      grading files, copied in only after the agent exits
 *   task.json    { "grade": argv, "checks": [...], "protect": [...], "unchanged": [...] }
 *                `checks` and `protect` become the workspace's harness.json in the harness
 *                variant. `unchanged` files must be byte-identical after the run, or it fails.
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
	const split = argv.indexOf("--");
	const own = split === -1 ? argv : argv.slice(0, split);
	const options = {
		tasks: path.join(repoRoot, "evals", "harness", "tasks"),
		only: undefined,
		variants: ["harness", "bare"],
		repeat: 1,
		timeoutMs: 1_800_000,
		out: undefined,
		keep: false,
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
		else if (arg === "--variants") options.variants = next().split(",");
		else if (arg === "--repeat") options.repeat = Number(next());
		else if (arg === "--timeout") options.timeoutMs = Number(next()) * 1000;
		else if (arg === "--out") options.out = path.resolve(next());
		else if (arg === "--keep") options.keep = true;
		else throw new Error(`Unknown option ${arg}`);
	}
	for (const variant of options.variants) {
		if (variant !== "harness" && variant !== "bare") throw new Error(`Unknown variant ${variant}`);
	}
	if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error("--repeat must be a positive integer");
	return options;
}

function loadTasks(dir, only) {
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
		});
}

function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function sha256(file) {
	return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "missing";
}

function prepareWorkspace(task, variant) {
	const cwd = mkdtempSync(path.join(tmpdir(), `harness-eval-${task.name}-`));
	cpSync(path.join(task.root, "files"), cwd, { recursive: true });
	git(cwd, ["init", "-q"]);
	git(cwd, ["add", "-A"]);
	git(cwd, ["-c", "user.email=eval@example.com", "-c", "user.name=eval", "commit", "-qm", "start"]);
	if (variant === "harness") {
		mkdirSync(path.join(cwd, ".midnight.server"), { recursive: true });
		const config = { checks: task.spec.checks ?? [], protect: task.spec.protect ?? [] };
		writeFileSync(path.join(cwd, ".midnight.server", "harness.json"), JSON.stringify(config, null, "\t"));
	}
	return cwd;
}

/** Run the agent and collect what its JSON event stream says about the run. */
function runAgent(cwd, prompt, variant, options, eventsPath) {
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
	if (variant === "bare") env.MIDNIGHT_SERVER_HARNESS = "0";
	else delete env.MIDNIGHT_SERVER_HARNESS;
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
		lastStopReason: undefined,
		exitCode: null,
		timedOut: false,
		stderrTail: "",
	};
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
				stats.toolCalls += message.content.filter((part) => part.type === "toolCall").length;
				const usage = message.usage ?? {};
				stats.input += usage.input ?? 0;
				stats.output += usage.output ?? 0;
				stats.cacheRead += usage.cacheRead ?? 0;
				stats.cacheWrite += usage.cacheWrite ?? 0;
				stats.cost += usage.cost?.total ?? 0;
				stats.lastStopReason = message.stopReason;
			} else if (message.role === "custom") {
				if (message.customType === "harness_check") stats.harnessChecks++;
				if (message.customType === "harness_contract") stats.contractReminders++;
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

function grade(task, cwd, originalHashes) {
	for (const [file, hash] of Object.entries(originalHashes)) {
		if (sha256(path.join(cwd, file)) !== hash) return { passed: false, reason: `${file} was changed` };
	}
	cpSync(path.join(task.root, "hidden"), cwd, { recursive: true });
	const [command, ...args] = task.spec.grade;
	const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 60_000, shell: false });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	return {
		passed: result.status === 0,
		reason: result.status === 0 ? "hidden tests pass" : output.split("\n").slice(0, 3).join(" | ").slice(0, 300),
	};
}

function summarize(records, variants) {
	const lines = ["", "variant   pass        tokens(in+out)  cache-read  cost($)  time(s)  checks  reminders"];
	for (const variant of variants) {
		const runs = records.filter((record) => record.variant === variant);
		if (runs.length === 0) continue;
		const passed = runs.filter((record) => record.passed).length;
		const mean = (pick) => runs.reduce((sum, record) => sum + pick(record), 0) / runs.length;
		lines.push(
			[
				variant.padEnd(9),
				`${passed}/${runs.length} (${Math.round((passed / runs.length) * 100)}%)`.padEnd(11),
				String(Math.round(mean((r) => r.input + r.output))).padStart(14),
				String(Math.round(mean((r) => r.cacheRead))).padStart(11),
				mean((r) => r.cost).toFixed(4).padStart(8),
				mean((r) => r.elapsedMs / 1000).toFixed(0).padStart(8),
				mean((r) => r.harnessChecks).toFixed(1).padStart(7),
				mean((r) => r.contractReminders).toFixed(1).padStart(10),
			].join(" "),
		);
	}
	lines.push("", "Per task (pass count per variant):");
	for (const name of [...new Set(records.map((record) => record.task))]) {
		const cells = variants.map((variant) => {
			const runs = records.filter((record) => record.task === name && record.variant === variant);
			return `${variant} ${runs.filter((record) => record.passed).length}/${runs.length}`;
		});
		lines.push(`  ${name.padEnd(20)} ${cells.join("   ")}`);
	}
	return lines.join("\n");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const tasks = loadTasks(options.tasks, options.only);
	if (tasks.length === 0) throw new Error(`No tasks in ${options.tasks}`);
	const out =
		options.out ??
		path.join(repoRoot, "evals", "harness", "results", `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
	mkdirSync(path.dirname(out), { recursive: true });
	// One JSON event stream per run, for reading trajectories after the fact.
	const eventsDir = `${out.replace(/\.jsonl$/, "")}.events`;
	mkdirSync(eventsDir, { recursive: true });
	console.log(`Agent args: ${options.agentArgs.join(" ") || "(configured default model)"}`);
	console.log(`Tasks: ${tasks.map((task) => task.name).join(", ")}; variants: ${options.variants.join(", ")}; repeat ${options.repeat}`);
	const records = [];
	for (let repeat = 0; repeat < options.repeat; repeat++) {
		for (const task of tasks) {
			// Alternate variant order per repeat so a warm cache or engine does not favor one side.
			const order = repeat % 2 === 0 ? options.variants : [...options.variants].reverse();
			for (const variant of order) {
				const cwd = prepareWorkspace(task, variant);
				const originalHashes = Object.fromEntries(
					(task.spec.unchanged ?? []).map((file) => [file, sha256(path.join(cwd, file))]),
				);
				const started = Date.now();
				const eventsPath = path.join(eventsDir, `${task.name}-${variant}-${repeat}.jsonl`);
				const stats = await runAgent(cwd, task.prompt, variant, options, eventsPath);
				const elapsedMs = Date.now() - started;
				const verdict = grade(task, cwd, originalHashes);
				const record = {
					task: task.name,
					variant,
					repeat,
					elapsedMs,
					...stats,
					...verdict,
					events: eventsPath,
					workspace: options.keep ? cwd : undefined,
				};
				records.push(record);
				writeFileSync(out, `${JSON.stringify(record)}\n`, { flag: "a" });
				console.log(
					`${verdict.passed ? "PASS" : "FAIL"}  ${task.name.padEnd(20)} ${variant.padEnd(8)} ${(elapsedMs / 1000).toFixed(0)}s  ${stats.input + stats.output} tok  ${verdict.reason}${stats.timedOut ? " (timed out)" : ""}`,
				);
				if (!options.keep) rmSync(cwd, { recursive: true, force: true });
			}
		}
	}
	console.log(summarize(records, options.variants));
	console.log(`\nResults: ${out}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
