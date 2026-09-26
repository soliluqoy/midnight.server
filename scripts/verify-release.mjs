#!/usr/bin/env node
// Verify a Linux/macOS release tarball the way a clean machine would see it.
// The Windows equivalent is scripts/verify-release.ps1.
//
// Extracts the archive to a directory whose path contains spaces and non-ASCII
// characters, checks every file against release-manifest.json, then runs the
// executable with a minimal PATH (no node or bun) and isolated state/config.
// --smoke also runs a local-model task (needs MIDNIGHT_SERVER_MODEL or network),
// checks that no engine process is left, and SIGKILLs the CLI while the engine
// runs to prove the engine does not outlive it.
//
// Usage: node scripts/verify-release.mjs <package.tar.gz> [--smoke] [--keep]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const packagePath = args.find((arg) => !arg.startsWith("--"));
const smoke = args.includes("--smoke");
const keep = args.includes("--keep");
if (!packagePath) {
	console.error("Usage: node scripts/verify-release.mjs <package.tar.gz> [--smoke] [--keep]");
	process.exit(2);
}

const failures = [];
function check(ok, label) {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures.push(label);
}
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// The random token is ASCII, so process listings match it however ps renders "ü".
const token = randomBytes(4).toString("hex");
const work = join(mkdtempSync(join(tmpdir(), "midnight-verify-")), `midnight verify ü ${token}`);
mkdirSync(work, { recursive: true });
const app = join(work, "midnight.server");
const exe = join(app, "midnight.server");

/**
 * Serving engines (llama-server and its host) started from this extracted copy.
 * `--api-key-file` excludes the short-lived device listing of the backend probe.
 */
function engineProcesses() {
	const listing = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
	return listing
		.split("\n")
		.filter((line) => line.includes(token) && line.includes("llama-server") && line.includes("--api-key-file"))
		.map((line) => line.trim());
}

async function waitFor(condition, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await sleep(250);
	}
	return condition();
}

try {
	console.log(`==> Extracting to ${work}`);
	execFileSync("tar", ["-xzf", resolve(packagePath), "-C", work]);
	const manifest = JSON.parse(readFileSync(join(app, "release-manifest.json"), "utf8"));

	console.log(`==> Checking ${manifest.files.length} files against release-manifest.json`);
	const bad = manifest.files
		.filter((file) => {
			const path = join(app, file.path);
			return (
				!existsSync(path) ||
				statSync(path).size !== file.bytes ||
				createHash("sha256").update(readFileSync(path)).digest("hex") !== file.sha256
			);
		})
		.map((file) => file.path);
	check(bad.length === 0, `file hashes (${bad.join(", ")})`);
	const [os] = manifest.platform.split("-");
	for (const required of [
		"midnight.server",
		`engine/${manifest.backend}/${manifest.engine.server}`,
		"photon_rs_bg.wasm",
		`native/${os}/prebuilds/${manifest.platform}`,
		"licenses/llama.cpp-LICENSE.txt",
		"THIRD_PARTY_NOTICES.md",
	]) {
		check(existsSync(join(app, required)), `present: ${required}`);
	}

	console.log("==> Running with minimal PATH and isolated state");
	const env = {
		HOME: process.env.HOME,
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		LANG: process.env.LANG ?? "C.UTF-8",
		MIDNIGHT_SERVER_HOME: join(work, "state"),
		MIDNIGHT_SERVER_CODING_AGENT_DIR: join(work, "agent"),
		...(process.env.MIDNIGHT_SERVER_MODEL ? { MIDNIGHT_SERVER_MODEL: process.env.MIDNIGHT_SERVER_MODEL } : {}),
	};
	const run = (commandArgs, options = {}) =>
		spawnSync(exe, commandArgs, { env, cwd: app, encoding: "utf8", timeout: 600_000, ...options });

	const version = run(["--version"]);
	check(
		version.status === 0 && version.stdout.trim() === manifest.version,
		`--version reports ${version.stdout.trim()} (expected ${manifest.version})`,
	);
	const help = run(["--help"]);
	check(help.status === 0 && help.stdout.includes("midnight.server"), "--help runs without loading the model");
	const status = run(["engine", "status"]);
	console.log(status.stdout.trim());
	check(status.status === 0, "engine status finds the bundled engine");

	if (smoke) {
		const helperArgs = [
			"helper",
			"summarize",
			"Summarize this file in one sentence.",
			"THIRD_PARTY_NOTICES.md",
			"--json",
		];
		console.log("==> Running a local-model task");
		const task = run(helperArgs);
		let result;
		try {
			result = JSON.parse(task.stdout);
		} catch {
			result = undefined;
		}
		if (!result) console.log(task.stdout, task.stderr);
		// A small model can fail schema validation; this checks that the engine starts and answers.
		check(typeof result?.status === "string", `helper task ran on the engine (status ${result?.status})`);
		check(await waitFor(() => engineProcesses().length === 0, 10_000), "no engine processes left after exit");

		// The first task saved the backend choice, so this run starts the engine without probing.
		console.log("==> Killing the CLI while the engine runs");
		const child = spawn(exe, helperArgs, { env, cwd: app, stdio: "ignore" });
		const started = await waitFor(() => engineProcesses().length > 0 || child.exitCode !== null, 300_000);
		check(started && child.exitCode === null, "engine started for the kill test");
		child.kill("SIGKILL");
		const cleaned = await waitFor(() => engineProcesses().length === 0, 15_000);
		if (!cleaned) {
			console.log(engineProcesses().join("\n"));
			for (const line of engineProcesses()) process.kill(Number(line.split(/\s+/)[0]), "SIGKILL");
		}
		check(cleaned, "engine exits when the CLI is killed");
	}
} finally {
	if (keep) console.log(`Kept ${work}`);
	else rmSync(join(work, ".."), { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`${failures.length} check(s) failed: ${failures.join("; ")}`);
	process.exit(1);
}
console.log(`Release verified: ${packagePath}`);
