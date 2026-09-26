#!/usr/bin/env node
// Write release-manifest.json for a Linux/macOS build layout: per-file SHA-256 plus
// build, engine and model identity. The Windows equivalent lives in scripts/build.ps1.
// Usage: node scripts/write-release-manifest.mjs <layout-dir> <platform> <backend> <engine-dir>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const [layoutDir, platform, backend, engineDir] = process.argv.slice(2);
if (!layoutDir || !platform || !backend || !engineDir) {
	console.error("Usage: node scripts/write-release-manifest.mjs <layout-dir> <platform> <backend> <engine-dir>");
	process.exit(2);
}
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const git = (...args) => {
	try {
		return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
};

function listFiles(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return listFiles(path);
		return entry.isFile() ? [path] : [];
	});
}

const files = listFiles(layoutDir)
	.map((path) => ({
		path: relative(layoutDir, path).split(sep).join("/"),
		bytes: statSync(path).size,
		sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
	}))
	.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const manifest = {
	product: "midnight.server",
	version: readJson(join(repoRoot, "packages/coding-agent/package.json")).version,
	platform,
	backend,
	sourceCommit: git("rev-parse", "HEAD"),
	sourceDirty: git("status", "--porcelain") !== "",
	builtAt: new Date().toISOString(),
	bun: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
	engine: readJson(join(engineDir, ".midnight-engine.json")),
	model: readJson(join(repoRoot, "models/minicpm5-2b-q8_0.lock.json")),
	modelIncluded: false,
	files,
};
writeFileSync(join(layoutDir, "release-manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
