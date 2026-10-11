import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = await mkdtemp(path.join(tmpdir(), "midnight-mod-test-"));
try {
	await mkdir(path.join(fixture, ".claude-plugin"));
	await writeFile(
		path.join(fixture, ".claude-plugin/plugin.json"),
		JSON.stringify({
			name: "midnight",
			version: "0.3.0",
			hooks: "./claude-mod/hooks.json",
		}),
	);
	await cp(path.join(root, "claude-mod"), path.join(fixture, "claude-mod"), { recursive: true });
	const result = spawnSync("claude", ["plugin", "test", fixture], { stdio: "inherit", windowsHide: true });
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} finally {
	await rm(fixture, { recursive: true, force: true });
}
