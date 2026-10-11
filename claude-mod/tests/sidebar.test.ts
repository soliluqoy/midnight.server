import { expect, test } from "claude-code/testing";

const pane = {
	plugin: "midnight",
	component: "Pane",
	requestId: "midnight-sidebar",
	surface: "terminal",
	viewport: { columns: 160, rows: 40, isFullscreen: true },
	props: {
		title: "Midnight",
		isFocused: true,
		bodyColumns: 34,
		placement: "dock",
		scroll: { offset: 0, bodyRows: 38 },
		view: {},
	},
} as const;
const snapshot = {
	available: true,
	repository: "/work",
	branch: "main",
	summary: { staged: 1, unstaged: 1, untracked: 0, conflicted: 0 },
	items: [{ path: "file.txt", code: "MM" }],
	total: 1,
	nextOffset: null,
};

test("native pane shows reported usage and browses files without a model", async ($, on) => {
	const calls: string[][] = [];
	on("session.start", () => ({ cwd: "/work" }));
	on("command.register", () => ({ value: undefined }));
	on("ui.open", () => ({ value: { isPlaced: true } }));
	on("session.cwd", () => ({ value: "/work" }));
	on("session.model", () => ({ value: "test-model" }));
	on("session.usage", () => ({
		value: { startedAt: 0, context: { window: 200000, percent: 0 }, cost: { usd: 0 }, rateLimits: [] },
	}));
	on("process.run", (_$, e) => {
		calls.push(e.argv);
		const data =
			e.argv[3] === "status"
				? snapshot
				: e.argv[3] === "list"
					? { items: [{ name: "file.txt", path: "file.txt", type: "file" }], nextOffset: null }
					: { items: [{ line: 1, text: "example" }], nextOffset: null };
		return { value: { exitCode: 0, stdout: JSON.stringify(data), stderr: "" } };
	});
	await $.session.start({ cwd: "/work", surface: "terminal", isInteractive: true });
	const ui = await $.ui.mount(pane);
	expect(await ui.find({ type: "Text", text: "test-model" })).toBeDefined();
	expect(await ui.find({ type: "Text", text: "Context 0%" })).toBeDefined();
	expect(await ui.find({ type: "Text", text: "Cost $0.00" })).toBeDefined();
	expect(calls.length).toBe(1);
	await ui.press({ key: "files" });
	await ui.press({ key: "file-0" });
	expect(await ui.find({ type: "Code" })).toBeDefined();
	await ui.press({ key: "staged" });
	expect(calls[calls.length - 1].slice(-2)).toEqual(["--layer", "staged"]);
	await ui.unmount();
});

test("print mode stays passive and other panes pass through", async ($, on) => {
	on("session.start", () => ({ cwd: "/work" }));
	on("command.register", () => ({ value: undefined }));
	on("session.surfaces", () => ({ value: [] }));
	on("ui.render", () => ({ type: "Text", props: {}, children: ["Another pane"] }));
	await $.session.start({ cwd: "/work", surface: null, isInteractive: false });
	const result = await $.command.run({ command: "midnight-sidebar", args: "" });
	expect(result.text).toMatch(/interactive Claude Code/);
	const ui = await $.ui.mount({ ...pane, requestId: "other" });
	expect(await ui.find({ type: "Text", text: "Another pane" })).toBeDefined();
});

test("failed Git refresh never looks clean and hidden panes do no Git work", async ($, on) => {
	let reads = 0;
	on("session.start", () => ({ cwd: "/work" }));
	on("turn.complete", () => ({ text: "" }));
	on("command.register", () => ({ value: undefined }));
	on("ui.open", () => ({ value: { isPlaced: true } }));
	on("ui.close", () => ({ value: undefined }));
	on("session.cwd", () => ({ value: "/work" }));
	on("session.model", () => ({ value: "test-model" }));
	on("session.usage", () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }));
	on("process.run", () => {
		reads++;
		return { value: { exitCode: 1, stdout: "", stderr: "Git failed" } };
	});
	await $.session.start({ cwd: "/work", surface: "terminal", isInteractive: true });
	const ui = await $.ui.mount(pane);
	expect(await ui.find({ type: "Text", text: "Git failed" })).toBeDefined();
	expect(await ui.find({ type: "Text", text: "Working tree clean" })).toBeUndefined();
	await $.command.run({ command: "midnight-sidebar", args: "hide" });
	await $.turn.complete({ turnId: "one", answer: "done", durationMs: 0, isAborted: false, usage: null });
	expect(reads).toBe(1);
});

test("session replacement discards an old file read and compact keeps a hidden pane closed", async ($, on) => {
	let directory = "/first";
	let opens = 0;
	let reads = 0;
	let began!: () => void;
	let finish!: () => void;
	const waiting = new Promise<void>((resolve) => {
		began = resolve;
	});
	on("session.start", () => ({ cwd: directory }));
	on("classic.SessionStart", () => ({}));
	on("command.register", () => ({ value: undefined }));
	on("session.surfaces", () => ({ value: ["terminal"] }));
	on("ui.open", () => {
		opens++;
		return { value: { isPlaced: true } };
	});
	on("ui.close", () => ({ value: undefined }));
	on("session.cwd", () => ({ value: directory }));
	on("session.model", () => ({ value: "test-model" }));
	on("session.usage", () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }));
	on("process.run", async (_$, e) => {
		reads++;
		if (e.argv[3] === "list") {
			await new Promise<void>((resolve) => {
				finish = resolve;
				began();
			});
			return {
				value: {
					exitCode: 0,
					stdout: JSON.stringify({ items: [{ name: "stale.txt", path: "stale.txt", type: "file" }], nextOffset: null }),
					stderr: "",
				},
			};
		}
		return { value: { exitCode: 0, stdout: JSON.stringify({ ...snapshot, branch: directory }), stderr: "" } };
	});
	await $.session.start({ cwd: directory, surface: "terminal", isInteractive: true });
	const ui = await $.ui.mount(pane);
	const navigation = ui.press({ key: "files" });
	await waiting;
	directory = "/second";
	await $.classic.SessionStart({ source: "clear" });
	finish();
	await navigation;
	expect(await ui.find({ type: "Text", text: "/second" })).toBeDefined();
	expect(await ui.find({ type: "Button", key: "file-0" })).toBeUndefined();
	await $.command.run({ command: "midnight-sidebar", args: "hide" });
	const before = reads;
	await $.classic.SessionStart({ source: "compact" });
	expect(reads).toBe(before);
	expect(opens).toBe(2);
});
