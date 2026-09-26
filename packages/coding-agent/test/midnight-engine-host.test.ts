import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostedCommand } from "../src/midnight/engine.ts";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
	}
	return check();
}

// The Windows host is midnight-host.exe (Job Object); this covers the POSIX wrapper.
describe.skipIf(process.platform === "win32")("POSIX engine host", () => {
	let dir: string;
	const children: ChildProcess[] = [];
	afterEach(() => {
		for (const child of children.splice(0)) child.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	});

	/** Start a fake engine that records its pid, then sleeps. */
	async function startHosted(): Promise<{ child: ChildProcess; enginePid: number; exited: Promise<number | null> }> {
		dir = mkdtempSync(join(tmpdir(), "midnight-host-"));
		const pidFile = join(dir, "engine.pid");
		const [command, args] = hostedCommand("/bin/sh", ["-c", `echo $$ > "${pidFile}"; exec sleep 60`], undefined);
		const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
		children.push(child);
		const exited = new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)));
		let enginePid = 0;
		await waitFor(() => {
			try {
				enginePid = Number(readFileSync(pidFile, "utf8").trim());
				return enginePid > 0;
			} catch {
				return false;
			}
		});
		expect(alive(enginePid)).toBe(true);
		return { child, enginePid, exited };
	}

	it("stops the engine when the ownership pipe closes, as when the CLI dies", async () => {
		const { child, enginePid, exited } = await startHosted();
		child.stdin?.destroy();
		await exited;
		expect(await waitFor(() => !alive(enginePid))).toBe(true);
	});

	it("stops the engine when the host is terminated", async () => {
		const { child, enginePid, exited } = await startHosted();
		child.kill("SIGTERM");
		await exited;
		expect(await waitFor(() => !alive(enginePid))).toBe(true);
	});

	it("exits with the engine's exit code when the engine stops on its own", async () => {
		dir = mkdtempSync(join(tmpdir(), "midnight-host-"));
		const [command, args] = hostedCommand("/bin/sh", ["-c", "exit 7"], undefined);
		const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
		children.push(child);
		const code = await new Promise<number | null>((resolveExit) =>
			child.once("exit", (exitCode) => resolveExit(exitCode)),
		);
		expect(code).toBe(7);
	});
});
