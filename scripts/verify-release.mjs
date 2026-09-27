#!/usr/bin/env node
// Verify a Linux/macOS release tarball the way a clean machine would see it.
// The Windows equivalent is scripts/verify-release.ps1.
//
// Extracts the archive to a directory whose path contains spaces and non-ASCII
// characters, checks every file against release-manifest.json, then runs the
// executable with a minimal PATH (no node or bun) and an isolated config directory.
//
// Usage: node scripts/verify-release.mjs <package.tar.gz> [--keep]
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const packagePath = args.find((arg) => !arg.startsWith("--"));
const keep = args.includes("--keep");
if (!packagePath) {
	console.error("Usage: node scripts/verify-release.mjs <package.tar.gz> [--keep]");
	process.exit(2);
}

const failures = [];
function check(ok, label) {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures.push(label);
}

const work = join(mkdtempSync(join(tmpdir(), "midnight-verify-")), `midnight verify ü ${randomBytes(4).toString("hex")}`);
mkdirSync(work, { recursive: true });
const app = join(work, "midnight.server");
const exe = join(app, "midnight.server");

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
		"photon_rs_bg.wasm",
		`native/${os}/prebuilds/${manifest.platform}`,
		"licenses/pi-LICENSE.txt",
		"THIRD_PARTY_NOTICES.md",
	]) {
		check(existsSync(join(app, required)), `present: ${required}`);
	}

	console.log("==> Running with minimal PATH and isolated config");
	const env = {
		HOME: process.env.HOME,
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		LANG: process.env.LANG ?? "C.UTF-8",
		MIDNIGHT_SERVER_CODING_AGENT_DIR: join(work, "agent"),
	};
	const run = (commandArgs) => spawnSync(exe, commandArgs, { env, cwd: app, encoding: "utf8", timeout: 600_000 });

	const version = run(["--version"]);
	check(
		version.status === 0 && version.stdout.trim() === manifest.version,
		`--version reports ${version.stdout.trim()} (expected ${manifest.version})`,
	);
	const help = run(["--help"]);
	check(help.status === 0 && help.stdout.includes("midnight.server"), "--help runs");
} finally {
	if (keep) console.log(`Kept ${work}`);
	else rmSync(join(work, ".."), { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`${failures.length} check(s) failed: ${failures.join("; ")}`);
	process.exit(1);
}
console.log(`Release verified: ${packagePath}`);
