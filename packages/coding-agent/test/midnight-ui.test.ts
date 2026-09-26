import { fauxAssistantMessage, type StopReason } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { type GitStatusSummary, GitStatusTracker, parseGitStatusPorcelainV2 } from "../src/core/git-status.ts";
import { collectSessionFileChanges, countPatchLines } from "../src/core/session-file-changes.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import agentModeExtension, { PLAN_MODE_TOOLS } from "../src/extensions/agent-mode.ts";
import { cleanSessionTitle, generateSessionTitle, type TitleCompleter } from "../src/midnight/session-title.ts";
import {
	getMidnightStatus,
	onMidnightStatusChange,
	reportMidnightActivity,
	updateMidnightStatus,
} from "../src/midnight/status.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { describeDrift, describeGitStatus, SidebarComponent } from "../src/modes/interactive/components/sidebar.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

afterEach(() => {
	updateMidnightStatus({ mode: undefined, engine: "off", drift: undefined, agentMode: "build" });
});

describe("parseGitStatusPorcelainV2", () => {
	it("counts staged, unstaged, untracked and conflicted paths with ahead/behind", () => {
		const output = [
			"# branch.oid 1234567",
			"# branch.head main",
			"# branch.upstream origin/main",
			"# branch.ab +2 -1",
			"1 M. N... 100644 100644 100644 aaa bbb src/staged.ts",
			"1 .M N... 100644 100644 100644 aaa bbb src/unstaged.ts",
			"1 MM N... 100644 100644 100644 aaa bbb src/both.ts",
			"2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts\tsrc/old.ts",
			"u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts",
			"? notes.txt",
			"! ignored.log",
		].join("\n");
		expect(parseGitStatusPorcelainV2(output)).toEqual({
			ahead: 2,
			behind: 1,
			staged: 3,
			unstaged: 2,
			untracked: 1,
			conflicted: 1,
			changedFiles: 6,
		});
	});

	it("leaves ahead/behind unset without an upstream and handles CRLF", () => {
		const status = parseGitStatusPorcelainV2("# branch.oid (initial)\r\n# branch.head main\r\n? a.txt\r\n");
		expect(status.ahead).toBeUndefined();
		expect(status.untracked).toBe(1);
		expect(status.changedFiles).toBe(1);
	});
});

describe("GitStatusTracker", () => {
	it("coalesces concurrent refreshes into one follow-up and notifies only on change", async () => {
		const results: GitStatusSummary[] = [
			{ staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changedFiles: 1 },
			{ staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changedFiles: 1 },
		];
		let calls = 0;
		const pending: Array<() => void> = [];
		const tracker = new GitStatusTracker("/repo", () => {
			calls++;
			const result = results[calls - 1];
			return new Promise((resolve) => pending.push(() => resolve(result)));
		});
		let changes = 0;
		tracker.onChange(() => changes++);

		const first = tracker.refresh();
		void tracker.refresh();
		void tracker.refresh();
		expect(calls).toBe(1);
		pending.shift()?.();
		await first;
		await Promise.resolve();
		expect(calls).toBe(2);
		pending.shift()?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(changes).toBe(1);
		expect(tracker.getStatus()?.unstaged).toBe(1);
	});
});

function assistantCall(id: string, name: string, args: Record<string, unknown>): SessionEntry {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id, name, arguments: args }],
			usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
		},
	} as unknown as SessionEntry;
}

function toolResult(id: string, toolName: string, details: unknown, isError = false): SessionEntry {
	return {
		type: "message",
		message: { role: "toolResult", toolCallId: id, toolName, content: [], details, isError },
	} as unknown as SessionEntry;
}

describe("collectSessionFileChanges", () => {
	it("counts patch lines without the file headers", () => {
		expect(countPatchLines("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n+more\n context")).toEqual({
			added: 2,
			removed: 1,
		});
	});

	it("sums edits per file, counts writes as added lines, skips failures, and lists most recent first", () => {
		const cwd = process.cwd();
		const entries = [
			assistantCall("1", "edit", { path: "src/a.ts" }),
			toolResult("1", "edit", { patch: "--- a\n+++ b\n-x\n+y" }),
			assistantCall("2", "write", { path: "src/b.ts", content: "one\ntwo\nthree" }),
			toolResult("2", "write", undefined),
			assistantCall("3", "edit", { path: "src/c.ts" }),
			toolResult("3", "edit", undefined, true),
			assistantCall("4", "edit", { path: "src/a.ts" }),
			toolResult("4", "edit", { patch: "+z" }),
			assistantCall("5", "read", { path: "src/d.ts" }),
			toolResult("5", "read", undefined),
		];
		expect(collectSessionFileChanges(entries, cwd)).toEqual([
			{ path: "src/a.ts", added: 2, removed: 1 },
			{ path: "src/b.ts", added: 3, removed: 0 },
		]);
	});
});

describe("session titles", () => {
	it("cleans quotes, trailing punctuation and newlines", () => {
		expect(cleanSessionTitle('  "Fix date parsing tests."\n')).toBe("Fix date parsing tests");
		expect(cleanSessionTitle("   ")).toBeUndefined();
		expect(cleanSessionTitle("x".repeat(80))?.length).toBe(60);
	});

	it("takes the first line of the session model's reply and ignores truncated or failed output", async () => {
		const model = (text: string, stopReason: StopReason = "stop") =>
			(async () => fauxAssistantMessage(text, { stopReason })) satisfies TitleCompleter;
		const signal = new AbortController().signal;
		expect(await generateSessionTitle(model('"Refactor the logger."\nThis session...'), "u", "a", signal)).toBe(
			"Refactor the logger",
		);
		expect(await generateSessionTitle(model("Refac", "length"), "u", "a", signal)).toBeUndefined();
		expect(await generateSessionTitle(model("", "error"), "u", "a", signal)).toBeUndefined();
	});
});

type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown;

function createFakePi(allTools: string[], active: string[]) {
	const handlers = new Map<string, Handler>();
	let activeTools = [...active];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getActiveTools: () => [...activeTools],
		getAllTools: () => allTools.map((name) => ({ name })),
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
	};
	agentModeExtension(pi as unknown as ExtensionAPI);
	const startTurn = () => {
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		handlers.get("before_agent_start")?.(event);
		return event.systemPromptOptions.sections;
	};
	const callTool = (toolName: string) => handlers.get("tool_call")?.({ toolName }) as { block?: boolean } | undefined;
	return { startTurn, callTool, activeTools: () => activeTools };
}

describe("agent mode extension", () => {
	const all = ["read", "bash", "edit", "write", "grep", "find", "ls", "delegate_local", "custom"];

	it("restricts tools in plan mode and restores the build loadout afterwards", () => {
		const fake = createFakePi(all, ["read", "bash", "edit", "write", "custom"]);
		updateMidnightStatus({ agentMode: "plan" });
		const sections = fake.startTurn();
		expect(fake.activeTools()).toEqual([...PLAN_MODE_TOOLS]);
		expect(sections.agent_mode).toContain("Plan mode is on");
		expect(fake.callTool("edit")?.block).toBe(true);
		expect(fake.callTool("grep")).toBeUndefined();

		updateMidnightStatus({ agentMode: "build" });
		const buildSections = fake.startTurn();
		expect(fake.activeTools()).toEqual(["read", "bash", "edit", "write", "custom"]);
		expect(buildSections.agent_mode).toBeUndefined();
		expect(fake.callTool("edit")).toBeUndefined();
	});

	it("keeps the original build loadout across several plan turns", () => {
		const fake = createFakePi(all, ["read", "edit"]);
		updateMidnightStatus({ agentMode: "plan" });
		fake.startTurn();
		fake.startTurn();
		updateMidnightStatus({ agentMode: "build" });
		fake.startTurn();
		expect(fake.activeTools()).toEqual(["read", "edit"]);
	});
});

function createSession(): AgentSession {
	const entries = [assistantCall("1", "edit", { path: "src/a.ts" }), toolResult("1", "edit", { patch: "+a\n-b" })];
	return {
		state: {
			model: { id: "claude-sonnet-5", provider: "anthropic", contextWindow: 200_000, reasoning: true },
			thinkingLevel: "high",
		},
		sessionManager: {
			getEntries: () => entries,
			getRevision: () => 0,
			getSessionName: () => "Fix date parsing",
			getCwd: () => process.cwd(),
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 42, tokens: 84_000 }),
		modelRuntime: { isUsingSubscription: () => false },
	} as unknown as AgentSession;
}

function createFooterData(): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "feature/sidebar",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

const gitStatus = {
	getStatus: (): GitStatusSummary => ({
		ahead: 1,
		staged: 1,
		unstaged: 2,
		untracked: 0,
		conflicted: 0,
		changedFiles: 3,
	}),
};

describe("sidebar and footer", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("describes git and drift state compactly", () => {
		expect(describeGitStatus(gitStatus.getStatus())).toEqual(["↑1", "3 changed", "1 staged"]);
		expect(describeGitStatus({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0, changedFiles: 0 })).toEqual([
			"clean",
		]);
		expect(describeDrift(getMidnightStatus())).toBe("off");
		updateMidnightStatus({ drift: { checking: false, lastVerdict: "drifting", turnsUntilCheck: 4 } });
		expect(describeDrift(getMidnightStatus())).toBe("drifting");
	});

	it("renders session, git, context, model, local and modified-file sections within width", () => {
		updateMidnightStatus({ mode: "hybrid", engine: "ready", agentMode: "plan" });
		const sidebar = new SidebarComponent({
			session: createSession,
			footerData: createFooterData(),
			gitStatus,
			getHeight: () => 40,
			agentModeKey: () => "tab",
		});
		const lines = sidebar.render(36);
		expect(lines).toHaveLength(40);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(36);
		const text = stripAnsi(lines.join("\n"));
		for (const expected of [
			"PLAN tab to switch",
			"Fix date parsing",
			"feature/sidebar",
			"↑1 · 3 changed · 1 staged",
			"42%",
			"claude-sonnet-5",
			"anthropic · thinking high",
			"engine ready",
			"src/a.ts",
			"+1 -1",
		]) {
			expect(text).toContain(expected);
		}
	});

	it("refreshes cached session scans in the sidebar and footer when the session changes", () => {
		const sessionManager = SessionManager.inMemory(process.cwd());
		const session = { ...createSession(), sessionManager } as unknown as AgentSession;
		const sidebar = new SidebarComponent({
			session: () => session,
			footerData: createFooterData(),
			gitStatus,
			getHeight: () => 40,
			agentModeKey: () => "tab",
		});
		const footer = new FooterComponent(session, createFooterData(), gitStatus);
		const sidebarText = () => stripAnsi(sidebar.render(36).join("\n"));
		const footerText = () => stripAnsi(footer.render(240).join("\n"));
		expect(sidebarText()).toContain("untitled");
		expect(footerText()).not.toContain("Renamed");

		const revision = sessionManager.getRevision();
		sessionManager.appendSessionInfo("Renamed");
		expect(sessionManager.getRevision()).not.toBe(revision);
		expect(sidebarText()).toContain("Renamed");
		expect(footerText()).toContain("• Renamed");
	});

	it("shows the mode badge, branch, dirty count and local status in the footer", () => {
		updateMidnightStatus({ mode: "hybrid", engine: "ready" });
		const footer = new FooterComponent(createSession(), createFooterData(), gitStatus);
		const first = stripAnsi(footer.render(240)[0]!);
		expect(first.startsWith("BUILD ")).toBe(true);
		expect(first).toContain("⎇ feature/sidebar ●3 ↑1");
		expect(first).toContain("☾ hybrid · local ready");
		for (const line of footer.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});

	it("drops to one line with the model when the sidebar is visible", () => {
		updateMidnightStatus({ mode: "hybrid", engine: "ready" });
		const footer = new FooterComponent(createSession(), createFooterData(), gitStatus, () => true);
		const lines = footer.render(240).map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("⎇");
		expect(lines[0]).toContain("claude-sonnet-5 • high");
		expect(lines[0]).not.toContain("☾");
	});

	it("routes engine progress into the status while a UI is subscribed instead of writing to stderr", () => {
		const writes: string[] = [];
		const write = process.stderr.write;
		process.stderr.write = ((chunk: string) => {
			writes.push(chunk);
			return true;
		}) as typeof process.stderr.write;
		const unsubscribe = onMidnightStatusChange(() => {});
		try {
			updateMidnightStatus({ mode: "hybrid", engine: "starting" });
			reportMidnightActivity("Starting local engine...");
			expect(writes).toEqual([]);
			expect(getMidnightStatus().activity).toBe("Starting local engine...");
			const footer = new FooterComponent(createSession(), createFooterData(), gitStatus);
			expect(stripAnsi(footer.render(240)[0]!)).toContain("☾ hybrid · Starting local engine...");
			unsubscribe();
			reportMidnightActivity("Preparing local model...");
			expect(writes).toEqual(["Preparing local model...\n"]);
		} finally {
			unsubscribe();
			process.stderr.write = write;
			updateMidnightStatus({ activity: undefined });
		}
	});
});
