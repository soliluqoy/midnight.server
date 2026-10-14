import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { compactToolRenderers } from "../src/compact-tools.ts";

type Context = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
const midnight = (mode: "truecolor" | "256color" = "truecolor") =>
	loadThemeFromPath(fileURLToPath(new URL("../themes/midnight.json", import.meta.url)), mode);
const result = (text: string, details?: unknown): AgentToolResult<unknown> => ({
	content: [{ type: "text", text }],
	details,
});
const plain = (component: Component, width = 80) =>
	component.render(width).map((line) => stripTerminalSequences(line).trimEnd());

function harness(name: string, args: Record<string, unknown>, base?: ToolRenderers) {
	let theme = midnight();
	let enabled = true;
	let row: Component | undefined;
	let invalidations = 0;
	const resolver = compactToolRenderers(() => enabled);
	const renderers = resolver(name, () => base);
	const renderCall = renderers.renderCall;
	const renderResult = renderers.renderResult;
	assert.ok(renderCall);
	assert.ok(renderResult);
	const context: Context = {
		args,
		toolCallId: "call",
		cwd: ".",
		state: {},
		lastComponent: undefined,
		argsComplete: true,
		executionStarted: false,
		isPartial: true,
		isError: false,
		expanded: false,
		showImages: false,
		durationMs: undefined,
		outputPad: 0,
		invalidate() {
			invalidations++;
			row?.invalidate();
		},
	};
	const call = () => {
		row = renderCall(args, theme, { ...context });
		return row;
	};
	const finish = (value: AgentToolResult<unknown>, error = false) => {
		context.executionStarted = true;
		context.isPartial = false;
		context.isError = error;
		const component = call();
		const extra = renderResult(value, { expanded: context.expanded, isPartial: false }, theme, {
			...context,
		});
		assert.deepEqual(extra.render(80), [], "paired results must not duplicate the row");
		return component;
	};
	return {
		context,
		renderResult,
		call,
		finish,
		dispose: resolver.dispose,
		get theme() {
			return theme;
		},
		get invalidations() {
			return invalidations;
		},
		setEnabled(value: boolean) {
			enabled = value;
		},
		setTheme(value: Theme) {
			theme = value;
		},
	};
}

test("compact tools share one-line operation, target, and semantic success marks", (t) => {
	const read = harness("read", { path: "src/theme.ts", offset: 3, limit: 2 });
	const edit = harness("edit", { file_path: "themes/midnight.json" });
	const bash = harness("bash", { command: "npm test\nsecond command" });
	for (const h of [read, edit, bash]) t.after(h.dispose);
	const row = read.finish(result("line one\nline two"));
	assert.deepEqual(plain(row), ["✓ read src/theme.ts:3-4 · 2 lines"]);
	assert.ok(row.render(80)[0].includes(read.theme.fg("success", "✓")));
	assert.ok(row.render(80)[0].includes(read.theme.fg("muted", "read")));
	assert.deepEqual(plain(edit.finish(result("Applied", { diff: "+new\n+more\n-old" }))), [
		"✓ edit themes/midnight.json · +2 −1",
	]);
	assert.deepEqual(plain(bash.finish(result("done"))), ["✓ bash npm test …"]);
});

test("evidence rows show operation and review counts without changing model-facing evidence", (t) => {
	const h = harness("midnight_evidence", { action: "add", kind: "claim" });
	t.after(h.dispose);
	const value = result("Original evidence result", { version: 1, summary: { review: 2, gaps: 3 } });
	const original = structuredClone(value);
	const component = h.finish(value);
	assert.deepEqual(plain(component), ["✓ midnight_evidence add claim · 2 review · 3 gaps"]);
	for (const width of [0, 1, 8, 24, 80])
		assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
	h.context.expanded = true;
	assert.match(plain(h.call()).join("\n"), /Original evidence result/);
	assert.deepEqual(value, original);
});

test("log-triage rows show actual routing, new requests, timing, and helper issues without mutating results", (t) => {
	for (const mode of ["local", "remote", "cache"] as const) {
		const h = harness("midnight_log_triage", { path: ".artifacts/build.log" });
		t.after(h.dispose);
		const attempts = mode === "remote" ? 2 : 0;
		const value = result("full evidence\nElapsed: 12 ms total; 8 ms provider wait.", {
			version: 2,
			mode,
			requestAttempts: attempts,
			totalMs: 12,
			errors: [],
			summaryTruncated: false,
		});
		const original = structuredClone(value);
		const row = h.finish(value);
		assert.match(plain(row)[0], new RegExp(`${mode} · ${attempts} req · 12ms`));
		for (const width of [0, 1, 8, 32, 80]) assert.ok(row.render(width).every((line) => visibleWidth(line) <= width));
		h.context.expanded = true;
		assert.match(plain(h.call()).join("\n"), /full evidence/);
		assert.deepEqual(value, original);
	}
	const h = harness("midnight_log_triage", { path: "build.log" });
	t.after(h.dispose);
	const details = {
		version: 2,
		mode: "remote",
		requestAttempts: 2,
		totalMs: 9,
		errors: ["HTTP 502"],
		summaryTruncated: false,
	};
	assert.match(plain(h.finish(result("details", details)))[0], /remote · issues · 2 req · 9ms/);
	assert.match(plain(h.finish(result("details", details), true))[0], /failed · remote · issues/);
	assert.match(
		plain(h.finish(result("details", { ...details, errors: [], summaryTruncated: true })))[0],
		/remote · issues/,
	);
	assert.match(plain(h.finish(result("preflight failure"), true))[0], /failed · preflight failure/);
	for (const invalid of [undefined, { ...details, totalMs: Number.NaN }, { ...details, mode: "injected" }]) {
		assert.match(plain(h.finish(result("one\ntwo", invalid)))[0], /2 lines/);
	}
});

test("queued and running rows use stationary signals and a single disposable render clock", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 10000 });
	const h = harness("bash", { command: "npm test" });
	t.after(h.dispose);
	assert.deepEqual(plain(h.call()), ["○ bash npm test · queued"]);
	h.context.executionStarted = true;
	const row = h.call();
	assert.deepEqual(plain(row), ["● bash npm test"]);
	assert.ok(row.render(80)[0].includes(h.theme.fg("accent", "●")));
	t.mock.timers.tick(3000);
	assert.deepEqual(plain(row), ["● bash npm test · 3s"]);
	assert.equal(h.invalidations, 3);
	h.finish(result("done"));
	t.mock.timers.tick(2000);
	assert.equal(h.invalidations, 3);
	h.context.isPartial = true;
	h.call();
	h.dispose();
	h.dispose();
	t.mock.timers.tick(2000);
	assert.equal(h.invalidations, 3);
});

test("failures remain visible after long commands and summaries fit narrow Unicode widths", (t) => {
	const h = harness("bash", { command: `npm test -- ${"long-argument ".repeat(30)}` });
	t.after(h.dispose);
	const row = h.finish(result("full details\nAssertion failed: expected 1, received 2"), true);
	assert.match(plain(row, 36)[0], /^! bash .* · failed/);
	assert.ok(row.render(80)[0].includes(h.theme.fg("error", "!")));
	for (const width of [0, 1, 2, 4, 8, 16, 36, 80]) {
		const lines = row.render(width);
		assert.equal(lines.length, 1);
		assert.ok(visibleWidth(lines[0]) <= width);
	}
	const unicode = harness("read", { path: "long/long/long/文档-e\u0301.ts\x1b[31m\n" });
	t.after(unicode.dispose);
	const unicodeRow = unicode.finish(result("read"));
	assert.match(plain(unicodeRow, 32)[0], /文档-e\u0301\.ts/);
	assert.ok(!unicodeRow.render(32)[0].includes("\x1b[31m"));
	assert.equal(plain(unicodeRow, 32).length, 1);
});

test("expanded and disabled views delegate to original renderers without changing saved results", (t) => {
	const seen: AgentToolResult<unknown>[] = [];
	const base: ToolRenderers = {
		renderShell: "self",
		renderCall: () => new Text("original call", 0, 0),
		renderResult: (value) => {
			seen.push(value);
			return new Text("original output", 0, 0);
		},
	};
	const h = harness("read", { path: "src/theme.ts" }, base);
	t.after(h.dispose);
	const value = result("source content", { preserved: true });
	h.finish(value);
	assert.deepEqual(seen, []);
	h.context.expanded = true;
	assert.deepEqual(plain(h.call()), ["original call", "original output"]);
	assert.equal(seen[0], value);
	h.context.expanded = false;
	h.setEnabled(false);
	assert.deepEqual(plain(h.call()), ["original call", "original output"]);
	assert.equal(seen.at(-1), value);
});

test("codemode formatting stays display-only and a result can render before its call", (t) => {
	const h = harness("codemode", {});
	t.after(h.dispose);
	h.context.isPartial = false;
	h.context.expanded = true;
	const value = result(
		JSON.stringify({ output: "hello\nworld", truncated: false, exit_code: 0, wall_time_seconds: 0.2 }),
	);
	const original = structuredClone(value);
	const row = h.renderResult(value, { expanded: true, isPartial: false }, h.theme, { ...h.context });
	assert.match(
		plain(row)
			.map((line) => line.trim())
			.join("\n"),
		/hello\nworld/,
	);
	assert.match(plain(row).join("\n"), /Exit code: 0 · 0.2s/);
	assert.deepEqual(value, original);
});

test("tool rows pick up a changed theme and preserve image results", (t) => {
	const h = harness("read", { path: "image.png" });
	t.after(h.dispose);
	const value: AgentToolResult<unknown> = {
		content: [{ type: "image", data: "unchanged", mimeType: "image/png" }],
		details: undefined,
	};
	const original = structuredClone(value);
	const before = h.finish(value).render(80);
	const light = loadThemeFromPath(
		fileURLToPath(
			new URL(
				"../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/light.json",
				import.meta.url,
			),
		),
		"truecolor",
	);
	h.setTheme(light);
	const after = h.call().render(80);
	assert.deepEqual(after.map(stripTerminalSequences), ["✓ read image.png · image"]);
	assert.notDeepEqual(after, before);
	assert.ok(after[0].includes(light.fg("success", "✓")));
	const indexed = midnight("256color");
	h.setTheme(indexed);
	const indexedRow = h.call().render(80)[0];
	assert.ok(indexedRow.includes(indexed.fg("success", "✓")));
	assert.ok(!indexedRow.includes(";2;"));
	assert.deepEqual(value, original);
});
