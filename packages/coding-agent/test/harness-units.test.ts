import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { ProjectedSessionEntry } from "../src/core/session-manager.ts";
import {
	boundOutput,
	diagnosticExcerpt,
	expandCommand,
	formatCheckFeedback,
	parsePorcelainZ,
	runCheck,
	selectChecks,
	workspaceRelative,
} from "../src/harness/checks.ts";
import { DEFAULT_CHECK_TIMEOUT_MS, defaultHarnessConfig, parseHarnessConfig } from "../src/harness/config.ts";
import harnessExtension from "../src/harness/extension.ts";
import { remapForeignPath, repairPowerShellCommand } from "../src/harness/interface-repair.ts";
import { planMasking } from "../src/harness/masking.ts";

describe("harness config", () => {
	it("fills defaults and validates checks", () => {
		const config = parseHarnessConfig({
			checks: [{ name: "types", command: ["npx", "tsc", "--noEmit"], when: ["**/*.ts"] }],
			protect: ["test/**"],
		});
		expect(config.checks).toEqual([
			{ name: "types", command: ["npx", "tsc", "--noEmit"], when: ["**/*.ts"], timeoutMs: DEFAULT_CHECK_TIMEOUT_MS },
		]);
		expect(config.protect).toEqual(["test/**"]);
		expect(config.masking).toEqual(defaultHarnessConfig().masking);
	});

	it.each([
		[{ checks: [{ name: "x", command: [] }] }, /command must not be empty/],
		[{ checks: [{ command: ["a"] }] }, /name is required/],
		[{ chekcs: [] }, /Unknown key "chekcs"/],
		[{ maxRepairRounds: -1 }, /non-negative integer/],
		[{ masking: { batchBytes: "big" } }, /masking.batchBytes/],
	])("rejects %j", (value, message) => {
		expect(() => parseHarnessConfig(value)).toThrow(message);
	});
});

describe("harness checks", () => {
	it("selects checks by changed files and expands {files}", () => {
		const checks = [
			{ name: "lint", command: ["biome", "check", "{files}"], when: ["**/*.ts"], timeoutMs: 1 },
			{ name: "all", command: ["make"], timeoutMs: 1 },
			{ name: "css", command: ["stylelint"], when: ["**/*.css"], timeoutMs: 1 },
		];
		expect(selectChecks(checks, [])).toEqual([]);
		const selected = selectChecks(checks, ["src/a.ts", "README.md"]);
		expect(selected.map((item) => item.check.name)).toEqual(["lint", "all"]);
		expect(expandCommand(selected[0].check.command, selected[0].files)).toEqual(["biome", "check", "src/a.ts"]);
	});

	it("keeps paths inside the workspace only", () => {
		const cwd = join(tmpdir(), "ws");
		expect(workspaceRelative(cwd, "src/a.ts")).toBe("src/a.ts");
		expect(workspaceRelative(cwd, join(cwd, "b", "c.ts"))).toBe("b/c.ts");
		expect(workspaceRelative(cwd, "../outside.ts")).toBeUndefined();
		expect(workspaceRelative(cwd, ".")).toBeUndefined();
	});

	it("keeps the head and tail of long output", () => {
		const text = `${"a".repeat(3000)}${"b".repeat(3000)}${"c".repeat(6000)}`;
		const bounded = boundOutput(text, 100, 200);
		expect(bounded.startsWith("a".repeat(100))).toBe(true);
		expect(bounded.endsWith("c".repeat(200))).toBe(true);
		expect(bounded).toContain("11700 bytes omitted");
	});

	it("extracts distinct diagnostic lines from the middle of long output", () => {
		const output = ["banner", "x".repeat(6_000), "expected: 2", "received: 3", "expected: 2", "tail"].join("\n");
		expect(diagnosticExcerpt(output)).toBe("expected: 2\nreceived: 3");
	});

	it("asks for a diagnosis when the same checks fail again", () => {
		const outcome = {
			name: "test",
			argv: ["npm", "test"],
			passed: false,
			exitCode: 1,
			timedOut: false,
			elapsedMs: 1200,
			output: "1 failed",
			truncated: false,
		};
		expect(formatCheckFeedback([outcome], 1, 2, false)).not.toContain("root cause");
		const repeated = formatCheckFeedback([outcome], 2, 2, true);
		expect(repeated).toContain("repair round 2 of 2");
		expect(repeated).toContain("[FAIL] test: npm test (exit 1, 1.2 s)");
		expect(repeated).toContain("root cause");
		expect(repeated).toContain("materially different repair");
		expect(formatCheckFeedback([outcome], 2, 2, true, false, false)).not.toContain(
			"Treat the previous approach as rejected",
		);
	});

	it("parses porcelain -z output including renames", () => {
		expect(parsePorcelainZ(" M src/a.ts\0?? new file.ts\0R  b.ts\0old b.ts\0")).toEqual([
			"src/a.ts",
			"new file.ts",
			"b.ts",
		]);
	});

	describe("runCheck", () => {
		let dir: string;
		beforeEach(async () => {
			dir = await mkdtemp(join(tmpdir(), "harness-check-"));
			await writeFile(join(dir, "ok.txt"), "good");
		});
		afterEach(async () => {
			await rm(dir, { recursive: true, force: true });
		});

		const script = "process.stdout.write('checked');process.exit(require('fs').existsSync('ok.txt')?0:3)";

		it("passes on exit 0 and captures output", async () => {
			const outcome = await runCheck(
				{ check: { name: "exists", command: [process.execPath, "-e", script], timeoutMs: 30_000 }, files: [] },
				dir,
				new AbortController().signal,
			);
			expect(outcome).toMatchObject({ passed: true, exitCode: 0, timedOut: false, output: "checked" });
		});

		it("fails on a non-zero exit and on a timeout", async () => {
			await rm(join(dir, "ok.txt"));
			const failed = await runCheck(
				{ check: { name: "exists", command: [process.execPath, "-e", script], timeoutMs: 30_000 }, files: [] },
				dir,
				new AbortController().signal,
			);
			expect(failed).toMatchObject({ passed: false, exitCode: 3 });
			const slow = await runCheck(
				{
					check: {
						name: "slow",
						command: [process.execPath, "-e", "setTimeout(() => {}, 20000)"],
						timeoutMs: 300,
					},
					files: [],
				},
				dir,
				new AbortController().signal,
			);
			expect(slow).toMatchObject({ passed: false, timedOut: true });
		});

		it("reports a missing executable as a failure", async () => {
			const outcome = await runCheck(
				{ check: { name: "missing", command: ["definitely-not-a-command-xyz"], timeoutMs: 5_000 }, files: [] },
				dir,
				new AbortController().signal,
			);
			expect(outcome.passed).toBe(false);
		});
	});
});

describe("observation masking", () => {
	const settings = { enabled: true, keepRecentResults: 1, minResultBytes: 100, batchBytes: 1_000 };
	let counter = 0;
	const assistant = (callId: string, args: unknown): ProjectedSessionEntry => {
		const message = {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "read", arguments: args }],
			timestamp: 0,
		};
		return {
			sourceEntry: { type: "message", id: `a${counter++}`, parentId: null, timestamp: "", message },
			messages: [message],
		} as unknown as ProjectedSessionEntry;
	};
	const result = (id: string, callId: string, bytes: number, toolName = "read"): ProjectedSessionEntry => {
		const message = {
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content: [{ type: "text", text: "x".repeat(bytes) }],
			isError: false,
			timestamp: 0,
		};
		return {
			sourceEntry: { type: "message", id, parentId: null, timestamp: "", message },
			messages: [message],
		} as unknown as ProjectedSessionEntry;
	};

	it("waits for a full batch, then elides every eligible old result at once", () => {
		const small = [
			assistant("c1", { path: "a.ts" }),
			result("r1", "c1", 600),
			assistant("c2", {}),
			result("r2", "c2", 600),
		];
		// Only r1 is old enough (keepRecentResults: 1) and 600 bytes is below the batch.
		expect(planMasking(small, settings).edits).toEqual([]);
		const entries = [...small, assistant("c3", {}), result("r3", "c3", 600)];
		const plan = planMasking(entries, settings);
		expect(plan.edits.map((edit) => edit.targetId)).toEqual(["r1", "r2"]);
		expect(plan.elidedBytes).toBe(1_200);
		const stub = plan.edits[0].replacement;
		expect(stub).toEqual({ content: expect.stringContaining('read {"path":"a.ts"} output elided') });
	});

	it("skips already-edited and small results", () => {
		const entries = [
			assistant("c1", {}),
			result("r1", "c1", 5_000),
			assistant("c3", {}),
			result("r3", "c3", 50),
			{
				sourceEntry: {
					type: "context_edit",
					id: "e1",
					parentId: null,
					timestamp: "",
					targetId: "r1",
					replacement: null,
				},
				messages: [],
			} as unknown as ProjectedSessionEntry,
			assistant("c4", {}),
			result("r4", "c4", 5_000),
		];
		expect(planMasking(entries, settings).edits).toEqual([]);
		expect(planMasking(entries, { ...settings, enabled: false }).edits).toEqual([]);
	});
});

describe("harness tool set", () => {
	type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

	function fakePi(active: string[]) {
		const handlers = new Map<string, Handler>();
		let activeTools = [...active];
		const pi = {
			on: (event: string, handler: Handler) => handlers.set(event, handler),
			registerTool: () => {},
			registerMessageRenderer: () => {},
			registerCommand: () => {},
			getActiveTools: () => [...activeTools],
			setActiveTools: (names: string[]) => {
				activeTools = [...names];
			},
		};
		harnessExtension(pi as unknown as ExtensionAPI);
		const start = async (provider: string) => {
			const event = {
				prompt: "",
				systemPromptOptions: { sections: {} as Record<string, string>, contextFiles: [], promptGuidelines: [] },
			};
			await handlers.get("before_agent_start")?.(event, {
				model: { provider },
				cwd: tmpdir(),
				isProjectTrusted: () => false,
				ui: { notify() {} },
			});
			return event.systemPromptOptions.sections;
		};
		return { start, activeTools: () => activeTools, handlers };
	}

	it("adds lookup and leaves the other tools alone", async () => {
		const fake = fakePi(["read", "edit", "mcp", "mcpScript"]);
		await fake.start("anthropic");
		expect(fake.activeTools().sort()).toEqual(["edit", "lookup", "mcp", "mcpScript", "read"]);
		await fake.start("anthropic");
		expect(fake.activeTools().sort()).toEqual(["edit", "lookup", "mcp", "mcpScript", "read"]);
	});

	it("gives shell calls without a timeout the default one, and keeps an explicit timeout", () => {
		const fake = fakePi([]);
		const call = (input: Record<string, unknown>) => {
			fake.handlers.get("tool_call")?.({ toolName: "powershell", toolCallId: "t", input }, { cwd: tmpdir() });
			return input;
		};
		expect(call({ command: "Get-ChildItem" }).timeout).toBe(300);
		expect(call({ command: "npm ci", timeout: 900 }).timeout).toBe(900);
		expect(call({ command: "ls 2>/dev/null" }).command).toBe("ls 2>$null");
	});
});

describe("interface repair", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "harness-repair-"));
		await writeFile(join(dir, "math.js"), "x");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const foreignRoot = "/no-such-root-7f3a";

	it("maps a path under a nonexistent root into the workspace", () => {
		expect(remapForeignPath(dir, `${foreignRoot}/math.js`, true)).toBe("math.js");
		expect(remapForeignPath(dir, `${foreignRoot}/deep/math.js`, true)).toBe("math.js");
		// write: the parent must exist, not the file.
		expect(remapForeignPath(dir, `${foreignRoot}/new.js`, false)).toBe("new.js");
	});

	it("leaves relative, workspace, real and unmatched paths alone", () => {
		expect(remapForeignPath(dir, "math.js", true)).toBeUndefined();
		expect(remapForeignPath(dir, join(dir, "math.js"), true)).toBeUndefined();
		expect(remapForeignPath(dir, join(tmpdir(), "missing-file-9x.js"), true)).toBeUndefined();
		expect(remapForeignPath(dir, `${foreignRoot}/other.js`, true)).toBeUndefined();
	});

	it("rewrites POSIX null redirects for PowerShell", () => {
		expect(repairPowerShellCommand('find / -name "a" 2>/dev/null')).toBe('find / -name "a" 2>$null');
		expect(repairPowerShellCommand("ls > /dev/null")).toBe("ls >$null");
		expect(repairPowerShellCommand("ls &>/dev/null")).toBe("ls *>$null");
		expect(repairPowerShellCommand("Get-ChildItem")).toBeUndefined();
	});
});
