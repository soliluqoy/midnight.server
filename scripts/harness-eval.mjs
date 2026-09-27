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
 *                       (MIDNIGHT_SERVER_HARNESS_FEATURES), e.g. no-pack=-contextPack,+contract.
 *                       Default: bare,harness. The first variant is the baseline.
 *   --manifest <file>   An explicit experiment design instead of --variants/--split/--repeat
 *                       (see scripts/harness-eval-design.mjs): every arm's full feature
 *                       assignment, repeats, and a seed that shuffles run order in each block.
 *   --checks <mode>     config: write the task's checks to harness.json (default).
 *                       detect: write only protected files; the harness detects checks itself.
 *   --repeat <n>        Runs per task and variant (default 1)
 *   --jobs <n>          Runs in parallel (default 1). Keep 1 for the local model.
 *   --timeout <s>       Per-run timeout in seconds (default 1800)
 *   --max-cost <usd>    Stop a run whose reported cost passes this; it counts as a failure.
 *   --out <file>        JSONL results (default evals/harness/results/<timestamp>.jsonl)
 *   --keep              Keep each run's workspace for inspection
 *   --resume            Skip runs already in --out (same task, variant and repeat) and add the rest
 *   --report <file>     Only print the report for an existing results file
 *
 * Each run's JSON event stream is saved next to the results as <out>.events/<task>-<variant>-<n>.jsonl,
 * and the harness's own decisions as ...telemetry.jsonl.
 *
 * Outcomes are kept apart, so none hides another: artifactPassed (the hidden grader on the final
 * files, run even after a timeout), unchangedOk, completed (normal end), timedOut, overBudget,
 * and success = all of them. `passed` is `success`. For drift: requirement-level results
 * (graders print `REQ <id> PASS|FAIL`), whether the visible checks pass at the end (a visible
 * pass with a hidden failure is the proxy gap), changed test files, claimed success and disclosed
 * deviation in the final message, and drift signals computed from the final change for every
 * run, harness on or off.
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
import { connect } from "node:net";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_NAMES } from "../packages/coding-agent/src/harness/features.ts";
import { actionable, claimsSuccess, detectDrift, disclosesDeviation } from "../packages/coding-agent/src/harness/drift.ts";
import { isTestPath } from "../packages/coding-agent/src/harness/workspace-index.ts";
import { hasCommand, parseRequirements, portableArgv } from "./harness-eval-commands.mjs";
import { parseVariant, parseVariantList, resolveManifest, seededShuffle } from "./harness-eval-design.mjs";
import { categorizeTurn, classifyToolError, formatReport } from "./harness-eval-stats.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
		resume: false,
		report: undefined,
		manifest: undefined,
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
		else if (arg === "--variants") options.variants = parseVariantList(next());
		else if (arg === "--manifest") options.manifest = path.resolve(next());
		else if (arg === "--checks") options.checks = next();
		else if (arg === "--repeat") options.repeat = Number(next());
		else if (arg === "--jobs") options.jobs = Number(next());
		else if (arg === "--timeout") options.timeoutMs = Number(next()) * 1000;
		else if (arg === "--max-cost") options.maxCost = Number(next());
		else if (arg === "--out") options.out = path.resolve(next());
		else if (arg === "--keep") options.keep = true;
		else if (arg === "--resume") options.resume = true;
		else if (arg === "--report") options.report = path.resolve(next());
		else throw new Error(`Unknown option ${arg}`);
	}
	if (options.manifest) {
		const design = resolveManifest(JSON.parse(readFileSync(options.manifest, "utf8")), FEATURE_NAMES);
		options.design = design;
		options.variants = design.variants;
		options.split = design.split;
		options.only = design.only ?? options.only;
		options.repeat = design.repeats;
		if (options.agentArgs.length === 0) options.agentArgs = design.agentArgs;
	}
	if (!["all", "dev", "holdout"].includes(options.split)) throw new Error("--split must be all, dev or holdout");
	if (!["config", "detect"].includes(options.checks)) throw new Error("--checks must be config or detect");
	if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error("--repeat must be a positive integer");
	if (!Number.isInteger(options.jobs) || options.jobs < 1) throw new Error("--jobs must be a positive integer");
	return options;
}

/** Relative path (forward slashes) to content, for every file under `root`. */
function readTree(root, base = root) {
	const files = new Map();
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) for (const [file, content] of readTree(full, base)) files.set(file, content);
		else files.set(path.relative(base, full).split(path.sep).join("/"), readFileSync(full, "utf8"));
	}
	return files;
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
				startFiles: readTree(path.join(root, "files")),
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

/** The loopback ports among `ports` that accept a connection. */
async function openPorts(ports) {
	const open = [];
	for (const port of ports) {
		const accepted = await new Promise((resolve) => {
			const socket = connect({ host: "127.0.0.1", port });
			const done = (value) => {
				socket.destroy();
				resolve(value);
			};
			socket.setTimeout(1000, () => done(false));
			socket.once("connect", () => done(true));
			socket.once("error", () => done(false));
		});
		if (accepted) open.push(port);
	}
	return open;
}

/** Count one harness message by type. */
function countHarnessMessage(stats, customType) {
	if (customType === "harness_check") stats.harnessChecks++;
	if (customType === "harness_drift") stats.driftNudges++;
	if (customType === "harness_contract") stats.contractReminders++;
	if (customType === "harness_advice") stats.advice++;
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
		driftNudges: 0,
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
		shellCommands: [],
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
			// Messages the harness adds when a run settles arrive as appended entries, not message_end.
			if (event.type === "entry_appended" && event.entry?.type === "custom_message") {
				countHarnessMessage(stats, event.entry.customType);
				return;
			}
			if (event.type !== "message_end") return;
			const message = event.message;
			if (message.role === "assistant") {
				stats.turns++;
				const calls = message.content.filter((part) => part.type === "toolCall");
				stats.toolCalls += calls.length;
				for (const call of calls) {
					const command = call.arguments?.command;
					if ((call.name === "bash" || call.name === "powershell") && typeof command === "string" && stats.shellCommands.length < 200) {
						stats.shellCommands.push(command.slice(0, 2000));
					}
				}
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
				countHarnessMessage(stats, message.customType);
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

/** Event counts from a run's harness telemetry, and the feature vector the harness resolved. */
function readTelemetry(file) {
	const result = { counts: {}, resolvedFeatures: undefined, modelClass: undefined };
	if (!existsSync(file)) return result;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			result.counts[event.type] = (result.counts[event.type] ?? 0) + 1;
			if (event.type === "features" && !result.resolvedFeatures) {
				result.resolvedFeatures = event.features;
				result.modelClass = event.modelClass;
			}
		} catch {
			// Ignore a partial last line.
		}
	}
	return result;
}

/** Every file that differs from the start commit, untracked files included, with both contents. */
function workspaceChanges(cwd) {
	const status = spawnSync("git", ["status", "--porcelain=v1", "-z", "-uall"], { cwd, encoding: "utf8" });
	if (status.status !== 0) return [];
	const changes = [];
	const fields = status.stdout.split("\0");
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index];
		if (field.length < 4) continue;
		const code = field.slice(0, 2);
		const file = field.slice(3);
		if (code.includes("R") || code.includes("C")) index++;
		if (file.startsWith(".midnight.server/")) continue;
		const shown = spawnSync("git", ["show", `HEAD:${file}`], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
		const before = shown.status === 0 ? shown.stdout : undefined;
		const target = path.join(cwd, file);
		const after = existsSync(target) ? readFileSync(target, "utf8") : undefined;
		if (before !== after) changes.push({ path: file, before, after });
	}
	return changes;
}

/** The task's visible checks on the final files: the proxy the agent could see. */
function runVisibleChecks(task, cwd) {
	const results = (task.spec.checks ?? []).map((check) => {
		const [command, ...args] = portableArgv(check.command);
		const result = spawnSync(command, args, {
			cwd,
			encoding: "utf8",
			timeout: 120_000,
			shell: process.platform === "win32",
			env: { ...process.env, CI: "1" },
			windowsHide: true,
		});
		return { name: check.name, passed: result.status === 0 };
	});
	return { passed: results.every((result) => result.passed), results };
}

/** The hidden grader on the final files. Run for every run, whatever else happened. */
function grade(task, cwd) {
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
		artifactPassed: result.status === 0,
		requirements: parseRequirements(output),
		reason: result.status === 0 ? "hidden tests pass" : output.split("\n").slice(0, 3).join(" | ").slice(0, 300),
	};
}

/**
 * Outcome and drift measures for one finished run, from the final workspace (before the hidden
 * files are copied in) and the agent's last message.
 */
function assessRun(task, cwd, stats, originalHashes, maxCost, changesPath) {
	const unchangedOk = Object.entries(originalHashes).every(([file, hash]) => sha256(path.join(cwd, file)) === hash);
	const changes = workspaceChanges(cwd);
	// The final change, kept so drift detectors can be re-scored on real runs later.
	writeFileSync(
		changesPath,
		JSON.stringify({ request: task.prompt, finalMessage: stats.lastText, changes, shellCommands: stats.shellCommands }),
	);
	const visible = runVisibleChecks(task, cwd);
	const graded = grade(task, cwd);
	const completed = !stats.timedOut && !stats.overBudget && stats.exitCode === 0 && stats.lastStopReason === "stop";
	const success = graded.artifactPassed && unchangedOk && completed;
	const claimed = claimsSuccess(stats.lastText);
	const disclosed = disclosesDeviation(stats.lastText);
	const startFiles = task.startFiles;
	const signals = detectDrift({
		request: task.prompt,
		changes,
		finalMessage: stats.lastText,
		// Post hoc, a claim is unsupported when the project's own checks fail at the end.
		verification: { verifiedAfterLastChange: true, lastCheckFailed: !visible.passed },
		testSources: new Map([...startFiles].filter(([file]) => isTestPath(file))),
		workspaceFiles: [...startFiles.keys()],
		shellCommands: stats.shellCommands,
	});
	let reason = graded.reason;
	if (!unchangedOk) reason = `a protected file was changed; ${reason}`;
	if (stats.overBudget) reason = `over the ${maxCost} budget; ${reason}`;
	return {
		artifactPassed: graded.artifactPassed,
		unchangedOk,
		completed,
		success,
		passed: success,
		reason,
		// A grader that crashed (for example on a syntax error) reports nothing: every declared
		// requirement it did not report is unmet, not left out of the average.
		requirements: Object.fromEntries(
			[...new Set([...(task.spec.requirements ?? []), ...Object.keys(graded.requirements)])].map((id) => [
				id,
				graded.requirements[id] ?? "not reported (the grader did not run to completion)",
			]),
		),
		visiblePassed: visible.passed,
		// The proxy passed and the specification did not: the SpecBench gap, per run.
		proxyGap: visible.passed && !graded.artifactPassed,
		changedFiles: changes.map((change) => change.path),
		testsModified: changes.filter((change) => isTestPath(change.path)).map((change) => change.path),
		claimedSuccess: claimed,
		disclosed,
		// Said it worked, did not, and did not say what was missing.
		silentDrift: claimed && !graded.artifactPassed && !disclosed,
		driftSignals: signals.map((signal) => signal.kind),
		driftActionable: actionable(signals).length,
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
	const runOne = async (task, variant, repeat) => {
		const cwd = prepareWorkspace(task, variant, options.checks);
		const originalHashes = Object.fromEntries(
			(task.spec.unchanged ?? []).map((file) => [file, sha256(path.join(cwd, file))]),
		);
		// A task's barrier (a service that must be down) can be defeated by a process an earlier run
		// left behind: record it, so contaminated runs can be told apart (evals/drift pilot 01).
		const portsOpenAtStart = await openPorts(task.spec.closedPorts ?? []);
		if (portsOpenAtStart.length > 0) console.log(`  warning: ${task.name}: port ${portsOpenAtStart.join(", ")} already open before the run`);
		const started = Date.now();
		const stem = path.join(eventsDir, `${task.name}-${variant.name}-${repeat}`);
		const stats = await runAgent(cwd, task.prompt, variant, options, `${stem}.jsonl`, `${stem}.telemetry.jsonl`);
		const elapsedMs = Date.now() - started;
		const portsLeftOpen = portsOpenAtStart.length > 0 ? [] : await openPorts(task.spec.closedPorts ?? []);
		if (portsLeftOpen.length > 0) console.log(`  warning: ${task.name} ${variant.name}: the run left port ${portsLeftOpen.join(", ")} open`);
		const outcome = assessRun(task, cwd, stats, originalHashes, options.maxCost, `${stem}.changes.json`);
		const telemetry = readTelemetry(`${stem}.telemetry.jsonl`);
		const record = {
			experimentId: options.design?.experimentId,
			task: task.name,
			family: task.spec.family ?? task.name,
			category: task.spec.category,
			split: task.spec.split,
			variant: variant.name,
			features: variant.harness ? variant.features || "(default)" : "off",
			assignment: variant.assignment,
			resolvedFeatures: telemetry.resolvedFeatures,
			modelClass: telemetry.modelClass,
			environmentContaminated: portsOpenAtStart.length > 0,
			environmentLeak: portsLeftOpen.length > 0,
			repeat,
			elapsedMs,
			...stats,
			...outcome,
			// Ended normally, said it was done, and the hidden tests fail.
			falseDone: !outcome.artifactPassed && outcome.completed,
			harnessEvents: telemetry.counts,
			events: `${stem}.jsonl`,
			workspace: options.keep ? cwd : undefined,
		};
		writeFileSync(out, `${JSON.stringify(record)}\n`, { flag: "a" });
		const failedRequirements = Object.entries(outcome.requirements)
			.filter(([, value]) => value !== true)
			.map(([id]) => id);
		console.log(
			`${outcome.success ? "PASS" : "FAIL"}  ${task.name.padEnd(22)} ${variant.name.padEnd(12)} ${(elapsedMs / 1000).toFixed(0)}s  ${stats.input + stats.output} tok  ${stats.turns} turns  ${outcome.success ? "" : outcome.reason}${failedRequirements.length ? ` [unmet: ${failedRequirements.join(", ")}]` : ""}${outcome.silentDrift ? " SILENT-DRIFT" : ""}${stats.timedOut ? " (timed out)" : ""}`,
		);
		if (!options.keep) {
			try {
				// Windows can hold a file briefly after a process exits; a leftover temp dir is harmless.
				rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
			} catch (error) {
				console.log(`  (could not remove ${cwd}: ${error instanceof Error ? error.message : error})`);
			}
		}
		return record;
	};
	// --resume: skip runs the results file already has, so a long experiment can be finished.
	const done = new Set();
	if (options.resume && existsSync(out)) {
		for (const line of readFileSync(out, "utf8").split("\n").filter(Boolean)) {
			const record = JSON.parse(line);
			done.add(`${record.task}|${record.variant}|${record.repeat}`);
		}
		console.log(`Resuming: ${done.size} runs already in ${out}`);
	}
	// One failing run must not stop the others: it is recorded as an error run.
	const guarded = (task, variant, repeat) => async () => {
		try {
			return await runOne(task, variant, repeat);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.log(`ERROR ${task.name} ${variant.name} #${repeat}: ${message}`);
			return { task: task.name, variant: variant.name, repeat, error: message, passed: false, success: false };
		}
	};
	const jobs = [];
	for (let repeat = 0; repeat < options.repeat; repeat++) {
		const block = [];
		for (const task of tasks) {
			// Without a design, alternate variant order per repeat so a warm cache does not favor one side.
			const order = repeat % 2 === 0 ? options.variants : [...options.variants].reverse();
			for (const variant of order) {
				if (!done.has(`${task.name}|${variant.name}|${repeat}`)) block.push(guarded(task, variant, repeat));
			}
		}
		// With a design, shuffle each repeat block with the manifest's seed: order effects (provider
		// load, warm caches) spread over arms instead of lining up with one.
		jobs.push(...(options.design ? seededShuffle(block, options.design.orderSeed + repeat) : block));
	}
	const fresh = await runPool(jobs, options.jobs);
	// The report covers every run in the file, including resumed ones.
	const records = options.resume
		? readFileSync(out, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: fresh.filter((record) => !record.error);
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
