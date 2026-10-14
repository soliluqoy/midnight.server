import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionToolContext,
	ExtensionUIDialogOptions,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import midnight, { MidnightPanels } from "../src/index.ts";
import { createKeybindings } from "../src/keys.ts";
import { QuestionParams, QuestionResult, registerQuestion } from "../src/question.ts";

type Params = Static<typeof QuestionParams>;
type Dialog = (
	title: string,
	choices: string[] | string | undefined,
	opts?: ExtensionUIDialogOptions,
) => Promise<string | undefined>;
const params: Params = {
	question: "Which storage should we use?",
	options: [{ label: "SQLite", description: "Recommended for local use" }, { label: "Postgres" }],
};
function harness(beforeOpen?: () => boolean) {
	const handlers = new Map<string, () => void>();
	let tool!: ToolDefinition<typeof QuestionParams>;
	const calls: { method: string; title: string; choices: string[] | string | undefined; signal?: AbortSignal }[] = [];
	let select: Dialog = async (_title, choices) => (choices as string[])[0];
	let input: Dialog = async () => "Custom answer";
	const pi = {
		on: (name: string, handler: () => void) => handlers.set(name, handler),
		registerTool: (value: ToolDefinition<typeof QuestionParams>) => {
			tool = value;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui",
		hasUI: true,
		signal: undefined,
		sessionManager: { getSessionId: () => "session" },
		ui: {
			select: async (title: string, choices: string[], opts?: ExtensionUIDialogOptions) => {
				calls.push({ method: "select", title, choices, signal: opts?.signal });
				return select(title, choices, opts);
			},
			input: async (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) => {
				calls.push({ method: "input", title, choices: placeholder, signal: opts?.signal });
				return input(title, placeholder, opts);
			},
		},
	} as unknown as ExtensionToolContext;
	const runtime = registerQuestion(pi, beforeOpen);
	const run = async (args = params, signal?: AbortSignal) => {
		assert.ok(Value.Check(QuestionParams, args));
		const value = await tool.execute("question-call", args, signal, undefined, ctx);
		assert.ok(Value.Check(QuestionResult, value.structuredContent));
		assert.deepEqual(value.details, value.structuredContent);
		assert.equal(value.content[0]?.type, "text");
		if (value.content[0]?.type === "text") assert.deepEqual(JSON.parse(value.content[0].text), value.details);
		return value.structuredContent as Static<typeof QuestionResult>;
	};
	return {
		run,
		runtime,
		calls,
		ctx,
		tool,
		emit: (name: string) => handlers.get(name)?.(),
		select: (dialog: Dialog) => {
			select = dialog;
		},
		input: (dialog: Dialog) => {
			input = dialog;
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("question is a model-only sequential tool with material-decision guidance, included by Midnight", () => {
	const h = harness();
	assert.equal(h.tool.exposure, "model-only");
	assert.equal(h.tool.executionMode, "sequential");
	assert.match(h.tool.promptGuidelines?.join(" ") ?? "", /materially change.*Do not ask about trivial.*cancelled/s);
	const tools: string[] = [];
	midnight({
		on() {},
		registerTool: (tool: ToolDefinition) => tools.push(tool.name),
		registerFlag() {},
		registerToolRenderer() {},
		registerCommand() {},
	} as unknown as ExtensionAPI);
	assert.ok(tools.includes("midnight_question"));
});

test("numbered choices retain descriptions, exact answer, and one-based identity", async () => {
	const h = harness();
	h.select(async (_title, choices) => (choices as string[])[1]);
	const data = await h.run();
	assert.equal(data.status, "answered");
	assert.equal(data.answer, "Postgres");
	assert.equal(data.selectedIndex, 2);
	assert.equal(data.wasCustom, false);
	assert.deepEqual(data.options, ["SQLite", "Postgres"]);
	assert.deepEqual(h.calls[0].choices, [
		"1. SQLite — Recommended for local use",
		"2. Postgres",
		"Other — write my own answer…",
	]);
	assert.equal(h.runtime.active, false);
});

test("Other and open questions use native text input; RPC uses the same public dialogs", async () => {
	for (const mode of ["tui", "rpc"] as const) {
		const h = harness();
		h.ctx.mode = mode;
		h.select(async (_title, choices) => (choices as string[]).at(-1));
		h.input(async () => "  文档 é with spaces  ");
		const data = await h.run();
		assert.equal(data.answer, "文档 é with spaces");
		assert.equal(data.wasCustom, true);
		assert.equal(data.selectedIndex, null);
		assert.deepEqual(
			h.calls.map((call) => call.method),
			["select", "input"],
		);
		assert.equal(h.calls[0].signal, h.calls[1].signal);
	}
	const h = harness();
	assert.equal((await h.run({ question: "Project name?" })).answer, "Custom answer");
	assert.deepEqual(
		h.calls.map((call) => call.method),
		["input"],
	);
});

test("Escape, blank input, and dismissed Other never imply consent or pick the first choice", async () => {
	const h = harness();
	h.select(async () => undefined);
	const cancelled = await h.run();
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.answer, null);
	assert.equal(cancelled.selectedIndex, null);
	assert.match(cancelled.reason, /Pause.*do not assume.*re-prompt/);
	assert.equal(h.calls.length, 1);
	for (const answer of [undefined, "", " \t "]) {
		h.select(async (_title, choices) => (choices as string[]).at(-1));
		h.input(async () => answer);
		assert.equal((await h.run()).status, "cancelled");
	}
});

test("noninteractive modes return explicit unavailable data without opening any UI", async () => {
	for (const mode of ["print", "json", "rpc", "tui"] as const) {
		const h = harness();
		h.ctx.mode = mode;
		h.ctx.hasUI = false;
		const data = await h.run();
		assert.equal(data.status, "unavailable");
		assert.equal(data.answer, null);
		assert.match(data.reason, /ordinary chat and wait/);
		assert.equal(h.calls.length, 0);
	}
});

test("schemas bound prompt/options and UI strips terminal controls without corrupting recorded labels", async () => {
	assert.equal(Value.Check(QuestionParams, { ...params, question: "" }), false);
	assert.equal(Value.Check(QuestionParams, { ...params, question: "x".repeat(1001) }), false);
	assert.equal(Value.Check(QuestionParams, { ...params, options: Array(7).fill({ label: "x" }) }), false);
	assert.equal(Value.Check(QuestionParams, { ...params, options: [{ label: "x".repeat(161) }] }), false);
	const h = harness();
	const data = await h.run({
		question: "\x1b[31m文档\x1b[0m\nname?",
		options: [{ label: "é\tfile", description: "a\x1b[2J\nb" }],
	});
	assert.equal(data.answer, "é\tfile");
	assert.equal(h.calls[0].title, "Midnight · 文档 name?");
	assert.equal((h.calls[0].choices as string[])[0], "1. é file — a b");
	assert.equal((await h.run({ question: " \t " })).status, "unavailable");
	assert.equal((await h.run({ question: "q", options: [{ label: " " }] })).status, "unavailable");
	assert.equal((await h.run({ question: "q", options: [{ label: "x" }, { label: " x " }] })).status, "unavailable");
	h.select(async () => "forged choice");
	assert.equal((await h.run()).status, "unavailable");
	h.input(async () => "x".repeat(4001));
	assert.equal((await h.run({ question: "q" })).status, "unavailable");
});

test("caller/context abort dismisses dialogs and ignores answers that arrive after cancellation", async () => {
	for (const contextSignal of [false, true]) {
		const h = harness();
		const controller = new AbortController();
		if (contextSignal) h.ctx.signal = controller.signal;
		const gate = deferred<string | undefined>();
		h.select(() => gate.promise);
		const pending = h.run(params, contextSignal ? undefined : controller.signal);
		assert.equal(h.runtime.active, true);
		controller.abort();
		assert.equal(h.calls[0].signal?.aborted, true);
		gate.resolve((h.calls[0].choices as string[])[0]);
		assert.equal((await pending).status, "cancelled");
		assert.equal(h.runtime.active, false);
	}
	const h = harness();
	const controller = new AbortController();
	controller.abort();
	assert.equal((await h.run(params, controller.signal)).status, "cancelled");
	assert.equal(h.calls.length, 0);
});

test("text-input cancellation on shutdown and UI errors both release active state", async () => {
	const h = harness();
	const gate = deferred<string | undefined>();
	h.input(() => gate.promise);
	const pending = h.run({ question: "q" });
	h.emit("session_shutdown");
	assert.equal(h.calls[0].signal?.aborted, true);
	gate.resolve("late answer");
	assert.equal((await pending).status, "cancelled");
	h.select(async () => {
		throw new Error("UI failure");
	});
	await assert.rejects(h.run(), /UI failure/);
	assert.equal(h.runtime.active, false);
});

test("reload/session replacement/tree navigation discard stale answers and old cleanup cannot clear a new question", async () => {
	for (const event of ["session_start", "session_tree", "session_shutdown"]) {
		const h = harness();
		const oldGate = deferred<string | undefined>();
		h.select(() => oldGate.promise);
		const old = h.run();
		h.emit(event);
		assert.equal(h.calls[0].signal?.aborted, true);
		const newGate = deferred<string | undefined>();
		h.select(() => newGate.promise);
		const current = h.run();
		oldGate.resolve((h.calls[0].choices as string[])[0]);
		assert.equal((await old).status, "cancelled");
		assert.equal(h.runtime.active, true);
		newGate.resolve((h.calls[1].choices as string[])[1]);
		assert.equal((await current).answer, "Postgres");
		assert.equal(h.runtime.active, false);
	}
});

test("another pending question or a panel dialog cannot be overwritten", async () => {
	const h = harness();
	const gate = deferred<string | undefined>();
	h.select(() => gate.promise);
	const pending = h.run();
	assert.equal((await h.run()).status, "unavailable");
	assert.equal(h.calls.length, 1);
	assert.equal(h.runtime.active, true);
	gate.resolve(undefined);
	await pending;
	const blocked = harness(() => false);
	assert.equal((await blocked.run()).status, "unavailable");
	assert.equal(blocked.calls.length, 0);
	assert.equal(blocked.runtime.active, false);
});

test("panel shortcut hook does not consume dialog keys or change focus while a question is active", () => {
	let active = true;
	const toggles: string[] = [];
	let ensures = 0;
	const panels = Object.assign(Object.create(MidnightPanels.prototype), {
		disposed: false,
		folderDialogOpen: false,
		questionActive: () => active,
		projectSwitchActive: () => false,
		tui: { hasOverlay: () => false },
		layout: {
			ensure: () => {
				ensures++;
			},
			visibility: () => ({ explorer: true }),
		},
		explorer: { focused: true },
		keys: createKeybindings(),
		toggleSidebar: () => toggles.push("sidebar"),
		toggleExplorer: () => toggles.push("explorer"),
	});
	const input = (data: string): unknown => Reflect.get(panels, "handleTerminalInput").call(panels, data);
	for (const key of ["\u001bs", "\u001be", "\r", "\u001b", "\u001b[A"]) assert.equal(input(key), undefined);
	assert.deepEqual(toggles, []);
	assert.equal(ensures, 0);
	active = false;
	assert.deepEqual(input("\u001bs"), { consume: true });
	assert.deepEqual(input("\u001be"), { consume: true });
	assert.deepEqual(toggles, ["sidebar", "explorer"]);
});

test("preparing panels for a question cancels previews and returns Explorer focus without replacing other dialogs", () => {
	let closed = 0;
	let focus: unknown;
	const explorer = { focused: true, render: () => [], invalidate() {} };
	const prompt = {};
	const panels = Object.assign(Object.create(MidnightPanels.prototype), {
		disposed: false,
		folderDialogOpen: false,
		modelDialogOpen: false,
		projectSwitchActive: () => false,
		previewGeneration: 0,
		sessionPreviewRequest: 0,
		closePreview: () => {
			closed++;
		},
		explorer,
		prompt,
		tui: {
			getFocusedComponent: () => explorer,
			setFocus: (value: unknown) => {
				focus = value;
			},
			requestRender() {},
		},
	}) as MidnightPanels;
	assert.equal(panels.prepareQuestion(), true);
	assert.equal(closed, 1);
	assert.equal(explorer.focused, false);
	assert.equal(focus, prompt);
	for (const flag of ["folderDialogOpen", "modelDialogOpen", "disposed"]) {
		Reflect.set(panels, flag, true);
		assert.equal(panels.prepareQuestion(), false);
		Reflect.set(panels, flag, false);
	}
	assert.equal(closed, 1);
});
