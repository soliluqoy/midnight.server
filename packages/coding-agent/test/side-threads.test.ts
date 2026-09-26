import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionModelRequest } from "../src/core/agent-session.ts";
import {
	answerText,
	assistantAnchor,
	buildSideThreadRequest,
	deleteSideThreadFile,
	formatThreadForMain,
	LOCAL_EXCERPT_CHARS,
	recentTranscript,
	type SideThread,
	SideThreadStore,
	sideThreadFileFor,
	toolCallAnchor,
} from "../src/core/side-threads.ts";

const model = {
	id: "cloud-model",
	provider: "cloud",
	api: "openai-completions",
	maxTokens: 32_000,
} as unknown as Model<Api>;
const local = {
	id: "minicpm5-2b-q8_0",
	provider: "midnight",
	api: "openai-completions",
	maxTokens: 8192,
} as Model<Api>;

function thread(overrides: Partial<SideThread> = {}): SideThread {
	return {
		anchorId: "tool:call-1",
		anchorLabel: "bash npm run check",
		excerpt: "Tool call: bash (failed)\nOutput:\nlint/style/useConst at footer.ts:160",
		turns: [],
		sentTurns: 0,
		createdAt: 1,
		...overrides,
	};
}

function userText(request: ReturnType<typeof buildSideThreadRequest>): string {
	const last = request.context.messages[request.context.messages.length - 1]!;
	return last.role === "user" && typeof last.content === "string" ? last.content : "";
}

describe("side thread store", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	function tempSessionFile(): string {
		const dir = mkdtempSync(join(tmpdir(), "side-threads-"));
		dirs.push(dir);
		return join(dir, "2026-01-01_abc.jsonl");
	}

	it("keeps threads beside the session file and reloads them", () => {
		const sessionFile = tempSessionFile();
		const file = sideThreadFileFor(sessionFile)!;
		expect(file).toBe(sessionFile.replace(/\.jsonl$/, ".threads.json"));

		const store = new SideThreadStore(file);
		const created = store.getOrCreate("tool:call-1", "bash ls", "output");
		created.turns.push({
			question: "why?",
			answer: "because",
			model: { provider: "cloud", id: "cloud-model", kind: "same" },
			status: "done",
			startedAt: 1,
			finishedAt: 2,
		});
		store.save();

		const reloaded = new SideThreadStore(file);
		expect(reloaded.get("tool:call-1")?.turns[0]?.answer).toBe("because");
	});

	it("marks answers that were streaming when the session closed as interrupted", () => {
		const file = sideThreadFileFor(tempSessionFile())!;
		const store = new SideThreadStore(file);
		store.getOrCreate("tool:call-1", "bash ls", "output").turns.push({
			question: "why?",
			answer: "partial",
			model: { provider: "midnight", id: "minicpm5-2b-q8_0", kind: "local" },
			status: "running",
			startedAt: 1,
		});
		store.save();

		const turn = new SideThreadStore(file).get("tool:call-1")?.turns[0];
		expect(turn?.status).toBe("aborted");
		expect(turn?.error).toBe("Interrupted");
	});

	it("removes the file when the last thread is deleted, and with the session", () => {
		const sessionFile = tempSessionFile();
		const file = sideThreadFileFor(sessionFile)!;
		const store = new SideThreadStore(file);
		store.getOrCreate("tool:a", "a", "a");
		store.save();
		expect(existsSync(file)).toBe(true);
		store.delete("tool:a");
		expect(existsSync(file)).toBe(false);

		writeFileSync(file, JSON.stringify({ version: 1, threads: [] }));
		deleteSideThreadFile(sessionFile);
		expect(existsSync(file)).toBe(false);
	});

	it("ignores a damaged file and keeps in-memory sessions in memory", () => {
		const file = sideThreadFileFor(tempSessionFile())!;
		writeFileSync(file, "{not json");
		expect(new SideThreadStore(file).all()).toEqual([]);

		const memory = new SideThreadStore(undefined);
		memory.getOrCreate("tool:a", "a", "a");
		memory.save();
		expect(memory.all()).toHaveLength(1);
		expect(readFileSync(file, "utf8")).toBe("{not json");
	});
});

describe("side thread requests", () => {
	const signal = new AbortController().signal;

	it("appends to the last session request so the cached prefix is reused", () => {
		const lastRequest: SessionModelRequest = {
			model,
			context: {
				systemPrompt: "main system prompt",
				tools: [{ name: "bash", description: "run", parameters: {} as never }],
				messages: [{ role: "user", content: "fix the lint errors", timestamp: 1 }],
			},
			options: { sessionId: "session-1", reasoning: "medium" },
		};
		const request = buildSideThreadRequest({
			model,
			kind: "same",
			thread: thread(),
			question: "is it only lint?",
			lastRequest,
			transcript: [],
			signal,
		});
		expect(request.context.systemPrompt).toBe("main system prompt");
		expect(request.context.tools).toBe(lastRequest.context.tools);
		expect(request.context.messages.slice(0, 1)).toEqual(lastRequest.context.messages);
		expect(request.context.messages).toHaveLength(2);
		expect(request.options).toMatchObject({ sessionId: "session-1", reasoning: "medium", signal });
		expect(userText(request)).toContain("Question: is it only lint?");
		expect(userText(request)).toContain("lint/style/useConst");
		// The main request is not modified.
		expect(lastRequest.context.messages).toHaveLength(1);
	});

	it("falls back to a short standalone request when the last request used another model", () => {
		const request = buildSideThreadRequest({
			model,
			kind: "same",
			thread: thread(),
			question: "why?",
			lastRequest: {
				model: { ...model, id: "other" },
				context: { messages: [] },
				options: {},
			},
			transcript: [{ role: "user", content: "fix the lint errors", timestamp: 1 }] as AgentMessage[],
			signal,
		});
		expect(request.context.tools).toBeUndefined();
		expect(request.context.messages).toHaveLength(1);
		expect(userText(request)).toContain("User: fix the lint errors");
	});

	it("gives the local model only the clipped item and prior answers", () => {
		const request = buildSideThreadRequest({
			model: local,
			kind: "local",
			thread: thread({
				excerpt: "x".repeat(50_000),
				turns: [
					{
						question: "first?",
						answer: "first answer",
						model: { provider: "midnight", id: local.id, kind: "local" },
						status: "done",
						startedAt: 1,
					},
				],
			}),
			question: "second?",
			lastRequest: undefined,
			transcript: [{ role: "user", content: "secret main prompt", timestamp: 1 }] as AgentMessage[],
			signal,
		});
		const text = userText(request);
		expect(text).not.toContain("secret main prompt");
		expect(text).toContain("Q: first?\nA: first answer");
		expect(text.length).toBeLessThan(LOCAL_EXCERPT_CHARS + 2000);
		expect(request.options.maxTokens).toBe(1024);
	});

	it("keeps recent conversation text within its budget, newest last", () => {
		const messages = [
			{ role: "user", content: "old question", timestamp: 1 },
			fauxAssistantMessage("old answer"),
			{ role: "user", content: "new question", timestamp: 3 },
		] as AgentMessage[];
		const text = recentTranscript(messages, 10_000);
		expect(text.indexOf("old question")).toBeLessThan(text.indexOf("new question"));
		expect(recentTranscript(messages, 20)).toContain("new question");
		expect(recentTranscript(messages, 20)).not.toContain("old question");
	});
});

describe("side thread helpers", () => {
	it("labels tool calls by their main argument and includes their output", () => {
		const anchor = toolCallAnchor(
			"bash",
			"call-9",
			{ command: "npm   run\ncheck" },
			{ content: [{ type: "text", text: "exit 1" }], isError: true },
			false,
		);
		expect(anchor).toMatchObject({ id: "tool:call-9", label: "bash npm run check" });
		expect(anchor.excerpt).toContain("(failed)");
		expect(anchor.excerpt).toContain("exit 1");
		expect(toolCallAnchor("todo", "c", {}, undefined, true).excerpt).toContain("still running");
	});

	it("anchors replies with text but not replies that only call tools", () => {
		const reply = fauxAssistantMessage("Fixed the lint error.");
		expect(assistantAnchor(reply)?.id).toBe(`assistant:${reply.timestamp}`);
		expect(assistantAnchor(fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })]))).toBeUndefined();
	});

	it("explains an answer that only contains a tool call", () => {
		const message = fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })]) as AssistantMessage;
		expect(answerText(message)).toContain("cannot run tools");
		expect(answerText(fauxAssistantMessage("  plain  "))).toBe("plain");
	});

	it("sends only turns that were not sent before", () => {
		const done = (question: string) => ({
			question,
			answer: `${question} answer`,
			model: { provider: "cloud", id: "cloud-model", kind: "same" as const },
			status: "done" as const,
			startedAt: 1,
		});
		const text = formatThreadForMain(thread({ turns: [done("one"), done("two")], sentTurns: 1 }));
		expect(text).toContain("Side thread about bash npm run check");
		expect(text).not.toContain("Q: one");
		expect(text).toContain("Q: two\nA (cloud-model): two answer");
	});
});
