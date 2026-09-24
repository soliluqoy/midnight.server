import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalEngine } from "../src/midnight/engine.ts";
import { createHelperTask, runHelperTask } from "../src/midnight/helper.ts";
import { findEngineDir, findHost, findModel } from "../src/midnight/store.ts";

// Loads the real 2.5 GiB model. Opt in with MIDNIGHT_SERVER_ENGINE_TESTS=1 after
// `midnight.server model fetch` and `midnight.server engine fetch` (or a source build).
const modelPath = findModel();
const engineDir = findEngineDir();
const hostPath = findHost();
const enabled =
	process.env.MIDNIGHT_SERVER_ENGINE_TESTS === "1" &&
	modelPath &&
	engineDir &&
	(hostPath || process.platform !== "win32");

function processIds(name: string): string[] {
	if (process.platform !== "win32") return [];
	const out = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/FO", "CSV", "/NH"], { encoding: "utf8" }).stdout;
	return out
		.split(/\r?\n/)
		.filter((line) => line.startsWith(`"${name}"`))
		.map((line) => line.split(",")[1]);
}

describe.runIf(enabled)("embedded engine (real model)", () => {
	let dir: string;
	let engine: LocalEngine;
	let serversBefore: string[];

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "midnight-engine-"));
		serversBefore = processIds("llama-server.exe");
		engine = await LocalEngine.start({
			modelPath: modelPath ?? "",
			engineDir: engineDir ?? "",
			hostPath,
			logPath: join(dir, "logs", "engine.log"),
			contextSize: 4096,
		});
	}, 240_000);

	afterAll(async () => {
		await engine?.stop();
		await rm(dir, { recursive: true, force: true });
	});

	it("requires the session key and deletes the key file", async () => {
		const post = (headers: Record<string, string>) =>
			fetch(`${engine.baseUrl}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...headers },
				body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
			}).then((response) => response.status);
		expect(await post({})).toBe(401);
		expect(await post({ Authorization: "Bearer wrong" })).toBe(401);
		expect(await post({ Authorization: `Bearer ${engine.apiKey}` })).toBe(200);
		expect(await readdir(join(dir, "run"))).toEqual([]);
	});

	it("generates, and recovers after a cancelled request", async () => {
		const controller = new AbortController();
		const pending = engine.chat({
			messages: [{ role: "user", content: "Count from 1 to 300." }],
			maxTokens: 1000,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 1000);
		await expect(pending).rejects.toThrow();
		const reply = await engine.chat({
			messages: [{ role: "user", content: "Reply with the single word: ready" }],
			maxTokens: 32,
			enableThinking: false,
		});
		expect(reply.content.toLowerCase()).toContain("ready");
	}, 120_000);

	it("runs a read-only helper task with evidence", async () => {
		await writeFile(
			join(dir, "port.ts"),
			"export function parsePort(value: string): number {\n\tconst port = Number(value);\n\tif (port < 0 || port > 65535) throw new Error('bad port');\n\treturn port;\n}\n",
		);
		const result = await runHelperTask(
			engine,
			createHelperTask({
				kind: "inspect",
				instruction: "Does parsePort reject non-numeric input such as 'abc'? Answer yes or no and explain.",
				workspaceRoot: dir,
				paths: ["port.ts"],
			}),
		);
		expect(result.status).toBe("completed");
		expect(result.checks.find((check) => check.name === "schema-valid")?.passed).toBe(true);
		expect(result.evidence.every((item) => item.path === "port.ts")).toBe(true);
	}, 240_000);

	it("leaves no engine process after stop", async () => {
		await engine.stop();
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(processIds("llama-server.exe").filter((pid) => !serversBefore.includes(pid))).toEqual([]);
	});
});
