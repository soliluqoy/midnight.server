import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { FileExplorerComponent } from "../src/file-explorer.ts";
import { createKeybindings } from "../src/keys.ts";
import type { PendingFile } from "../src/session-pending-files.ts";
import { Sidebar } from "../src/sidebar.ts";
import type { WorkspaceSnapshot } from "../src/workspace-files.ts";

const midnight = (mode: "truecolor" | "256color" = "truecolor") =>
	loadThemeFromPath(fileURLToPath(new URL("../themes/midnight.json", import.meta.url)), mode);
const light = () =>
	loadThemeFromPath(
		fileURLToPath(
			new URL(
				"../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/light.json",
				import.meta.url,
			),
		),
		"truecolor",
	);
const plain = (lines: string[]) => lines.map(stripTerminalSequences);
const click = (y: number): TuiMouseEvent => ({
	type: "click",
	button: "left",
	x: 3,
	y,
	screenX: 3,
	screenY: y,
	width: 36,
	height: 40,
	shift: false,
	alt: false,
	ctrl: false,
});

function explorerHarness(inputBlocked: () => boolean = () => false) {
	let theme = midnight();
	let height = 24;
	let changes: ReadonlySet<string> = new Set(["src/theme.ts"]);
	const opened: string[] = [];
	const previewed: string[] = [];
	const snapshot: WorkspaceSnapshot = {
		children: (dir) =>
			dir === ""
				? [{ name: "src", path: "src", directory: true }]
				: [
						{ name: "theme.ts", path: "src/theme.ts", directory: false },
						{ name: "文档-e\u0301.ts", path: "src/文档-e\u0301.ts", directory: false },
						{ name: ".cache", path: "src/.cache", directory: false },
					],
		mark: (file) => (file === "src/theme.ts" ? "M" : undefined),
		containsMarks: (file) => file === "src",
		isIgnored: (file) => file === "src/.cache",
	};
	const explorer = new FileExplorerComponent({
		theme: () => theme,
		keybindings: createKeybindings(),
		inputBlocked,
		isProjectRoot: () => true,
		rootPath: () => path.resolve("midnight.server"),
		sessionChanges: () => changes,
		getHeight: () => height,
		onExpand() {},
		onFolder() {},
		onParent() {},
		onProject() {},
		onExit() {},
		onToggle() {},
		onPassthrough() {},
		onOpen: (file) => opened.push(file),
		onPreview: (file) => previewed.push(file),
	});
	explorer.setSnapshot(snapshot);
	explorer.render(32);
	explorer.handleInput("\x1b[C");
	explorer.handleInput("\x1b[B");
	return {
		explorer,
		opened,
		previewed,
		get theme() {
			return theme;
		},
		setTheme(value: Theme) {
			theme = value;
			explorer.invalidate();
		},
		setHeight(value: number) {
			height = value;
		},
		clearChanges() {
			changes = new Set();
		},
	};
}

function pending(file: string, added?: number, removed?: number): PendingFile {
	return {
		path: file,
		absolute: path.resolve(file),
		state: "pending",
		generation: 1,
		added,
		removed,
		history: { path: file, added: 0, removed: 0, edits: [] },
	};
}

function sidebarHarness(inputBlocked: () => boolean = () => false) {
	let theme = midnight();
	let percent: number | undefined = 42;
	let height = 40;
	let selectedModels = 0;
	const previews: PendingFile[] = [];
	const ctx = {
		cwd: path.resolve("midnight.server"),
		sessionManager: {
			getSessionId: () => "test",
			getEntryCount: () => 0,
			getLeafId: () => null,
			getEntries: () => [],
			getBranch: () => [],
			getSessionName: () => "Refine the explorer",
		},
		getContextUsage: () => ({ percent, tokens: 84000, contextWindow: 200000 }),
		model: { id: "model-name", provider: "test", contextWindow: 200000 },
		modelRegistry: { isUsingOAuth: () => false },
		ui: {
			get theme() {
				return theme;
			},
		},
	} as unknown as ExtensionContext;
	const sidebar = new Sidebar(
		() => ctx,
		{ getThinkingLevel: () => "high" } as unknown as ExtensionAPI,
		() => height,
		(row) => previews.push(row),
		() => {
			selectedModels++;
		},
		() => true,
		() => {},
		inputBlocked,
	);
	sidebar.branch = "main";
	sidebar.git = { changedFiles: 3, staged: 1, unstaged: 2, untracked: 0, conflicted: 0 };
	sidebar.refresh();
	return {
		sidebar,
		previews,
		get theme() {
			return theme;
		},
		get selectedModels() {
			return selectedModels;
		},
		setTheme(value: Theme) {
			theme = value;
			sidebar.invalidate();
		},
		setPercent(value: number | undefined) {
			percent = value;
			sidebar.refresh();
		},
		setHeight(value: number) {
			height = value;
		},
	};
}

test("question dialogs retain mouse and keyboard ownership over both panels", (t) => {
	let blocked = false;
	const explorer = explorerHarness(() => blocked);
	const sidebar = sidebarHarness(() => blocked);
	t.after(() => sidebar.sidebar.dispose());
	explorer.explorer.render(32);
	const lines = plain(sidebar.sidebar.render(36));
	const modelRow = lines.findIndex((line) => line.includes("model-name"));
	assert.ok(modelRow >= 0);
	blocked = true;
	assert.deepEqual(explorer.explorer.handleMouse(click(3)), { handled: true });
	explorer.explorer.handleInput("\r");
	assert.deepEqual(explorer.opened, []);
	assert.deepEqual(sidebar.sidebar.handleMouse(click(modelRow)), { handled: true });
	assert.equal(sidebar.selectedModels, 0);
	blocked = false;
	explorer.explorer.handleInput("\r");
	assert.deepEqual(explorer.opened, ["src/theme.ts"]);
	sidebar.sidebar.handleMouse(click(modelRow));
	assert.equal(sidebar.selectedModels, 1);
});

test("Triage stays compact in the sidebar without reported cost text", (t) => {
	const h = sidebarHarness();
	t.after(() => h.sidebar.dispose());
	assert.doesNotMatch(plain(h.sidebar.render(32)).join("\n"), /TRIAGE/);
	h.sidebar.triage = { enabled: true, requests: 0, tokens: 0, incomplete: false, localCalls: 0, cacheHits: 0 };
	h.sidebar.invalidate();
	let lines = plain(h.sidebar.render(32));
	const start = lines.findIndex((row) => row.includes("TRIAGE"));
	assert.match(lines[start], /TRIAGE\s+on/);
	assert.match(lines[start + 1], /0 req · 0 tokens/);
	assert.match(lines[start + 2], /0 local · 0 cache/);
	assert.match(lines[start + 3], /not used yet/);
	assert.doesNotMatch(lines.slice(start).join("\n"), /\$|reported/);
	h.sidebar.triage = {
		enabled: false,
		requests: 2,
		tokens: 1200,
		incomplete: true,
		localCalls: 1,
		cacheHits: 2,
		lastCall: { mode: "remote", reason: "no_local_match", totalMs: 8, providerMs: 5, issues: true },
	};
	h.sidebar.invalidate();
	lines = plain(h.sidebar.render(32));
	assert.match(lines[start], /TRIAGE\s+off/);
	assert.match(lines[start + 1], /2 req · 1.2k tokens\*/);
	assert.match(lines[start + 2], /1 local · 2 cache/);
	assert.match(lines[start + 3], /last: remote · 8ms · issues/);
	assert.ok(h.sidebar.render(32)[start + 3].includes(h.theme.fg("warning", "last: remote · 8ms · issues")));
	assert.match(lines[start + 4], /usage incomplete/);
	for (const mode of ["local", "remote", "cache"] as const) {
		h.sidebar.triage.lastCall = { mode, reason: null, totalMs: 5, providerMs: 0, issues: false };
		h.sidebar.invalidate();
		assert.match(plain(h.sidebar.render(32))[start + 3], new RegExp(`last: ${mode} · 5ms`));
	}
	h.sidebar.triage.lastCall = undefined;
	h.sidebar.invalidate();
	assert.match(plain(h.sidebar.render(32))[start + 3], /remote requested/);
	for (const width of [0, 1, 8, 24, 32]) assert.ok(h.sidebar.render(width).every((row) => visibleWidth(row) <= width));
	h.sidebar.triage = undefined;
	h.sidebar.invalidate();
	assert.doesNotMatch(plain(h.sidebar.render(32)).join("\n"), /TRIAGE/);
});

test("evidence sidebar stays local, width-safe, and visible when only review items remain", (t) => {
	const h = sidebarHarness();
	t.after(() => h.sidebar.dispose());
	assert.doesNotMatch(plain(h.sidebar.render(36)).join("\n"), /EVIDENCE/);
	h.sidebar.evidence = {
		evidence: 2,
		claims: 1,
		review: 1,
		gaps: 2,
		receipts: 1,
		capacityReached: false,
		invalidEvents: 0,
	};
	h.sidebar.invalidate();
	const rendered = h.sidebar.render(36);
	const lines = plain(rendered);
	assert.match(lines.join("\n"), /EVIDENCE\s+local/);
	assert.match(lines.join("\n"), /2 sources · 1 claims/);
	assert.ok(rendered.some((row) => row.includes(h.theme.fg("warning", "1 review · 2 open gaps"))));
	h.sidebar.evidence = {
		evidence: 0,
		claims: 0,
		review: 1,
		gaps: 0,
		receipts: 0,
		capacityReached: true,
		invalidEvents: 0,
	};
	h.sidebar.invalidate();
	assert.match(plain(h.sidebar.render(36)).join("\n"), /EVIDENCE[\s\S]*Capture limit reached/);
	for (const width of [0, 1, 8, 24, 36]) assert.ok(h.sidebar.render(width).every((row) => visibleWidth(row) <= width));
	h.sidebar.evidence.invalidEvents = 1;
	h.sidebar.invalidate();
	assert.match(plain(h.sidebar.render(36)).join("\n"), /Stored events need inspection/);
	h.sidebar.evidence = {
		...h.sidebar.evidence,
		review: 0,
		capacityReached: false,
		invalidEvents: 0,
		unavailable: "History read-only; inspect status",
	};
	h.sidebar.invalidate();
	assert.match(plain(h.sidebar.render(36)).join("\n"), /EVIDENCE[\s\S]*History read-only/);
	assert.doesNotMatch(plain(h.sidebar.render(36)).join("\n"), /0 sources|0 claims|0 review/);
});

test("Explorer uses a local rail and ice-blue name, not a full-height bright border", () => {
	const h = explorerHarness();
	const inactive = h.explorer.render(32);
	assert.ok(!plain(inactive).some((row) => row.includes("▎")));
	h.explorer.focused = true;
	const active = h.explorer.render(32);
	const index = plain(active).findIndex((row) => row.includes("theme.ts"));
	assert.equal(plain(active)[index].indexOf("theme.ts"), plain(inactive)[index].indexOf("theme.ts"));
	assert.ok(active[index].includes(h.theme.fg("accent", "▎")));
	assert.ok(active[index].includes(h.theme.fg("borderAccent", "theme.ts")));
	assert.ok(active[index].includes(h.theme.getBgAnsi("selectedBg")));
	assert.ok(active[index].includes(h.theme.fg("accent", "●")));
	assert.ok(active[index].includes(h.theme.fg("warning", "M")));
	assert.ok(active[0].endsWith(h.theme.fg("borderAccent", "│")));
	assert.ok(active.slice(2).every((row) => row.endsWith(h.theme.fg("borderMuted", "│"))));
	const clipped = h.explorer.render(16).find((row) => stripTerminalSequences(row).includes("▎"));
	assert.ok(clipped);
	assert.ok(clipped.includes(h.theme.getBgAnsi("selectedBg")));
	assert.ok(!clipped.includes("\x1b[0m"), "clipped labels must not reset the selection background");
	h.clearChanges();
	assert.doesNotMatch(plain(h.explorer.render(32))[index], /●/);
});

test("Explorer preserves keyboard preview, insertion, and mouse row coordinates", () => {
	const h = explorerHarness();
	h.explorer.focused = true;
	h.explorer.handleInput(" ");
	h.explorer.handleInput("\r");
	assert.deepEqual(h.previewed, ["src/theme.ts"]);
	assert.deepEqual(h.opened, ["src/theme.ts"]);
	const index = plain(h.explorer.render(32)).findIndex((row) => row.includes("文档"));
	h.explorer.handleMouse({ ...click(index), clickCount: 2 });
	assert.equal(h.opened.at(-1), "src/文档-e\u0301.ts");
});

test("panels obey tiny widths and heights, resize, and rebuild colors for a light theme", (t) => {
	const e = explorerHarness();
	const s = sidebarHarness();
	t.after(() => s.sidebar.dispose());
	for (const height of [1, 2, 3, 6, 12, 24]) {
		e.setHeight(height);
		s.setHeight(height);
		for (const width of [0, 1, 2, 8, 16, 32, 36]) {
			for (const lines of [e.explorer.render(width), s.sidebar.render(width)]) {
				assert.equal(lines.length, height);
				assert.ok(lines.every((row) => visibleWidth(row) <= width));
			}
		}
	}
	e.setHeight(24);
	s.setHeight(40);
	e.explorer.focused = true;
	const before = e.explorer.render(32);
	e.setTheme(light());
	s.setTheme(light());
	const after = e.explorer.render(32);
	assert.notDeepEqual(after, before);
	assert.ok(after.some((row) => row.includes(e.theme.fg("accent", "▎"))));
	assert.ok(after.some((row) => row.includes(e.theme.fg("warning", "M"))));
	assert.ok(s.sidebar.render(36)[0].includes(s.theme.fg("accent", "MIDNIGHT")));
	assert.ok(!after.join("").includes(midnight().getFgAnsi("accent")));
});

test("panel focus, selection, and telemetry also render with 256-color tokens", (t) => {
	const e = explorerHarness();
	const s = sidebarHarness();
	t.after(() => s.sidebar.dispose());
	const theme = midnight("256color");
	e.setTheme(theme);
	s.setTheme(theme);
	e.explorer.focused = true;
	const rows = e.explorer.render(32);
	assert.ok(rows.some((row) => row.includes(theme.fg("accent", "▎"))));
	assert.ok(rows.some((row) => row.includes(theme.getBgAnsi("selectedBg"))));
	assert.ok(rows.some((row) => row.includes(theme.fg("warning", "M"))));
	assert.ok(s.sidebar.render(36).some((row) => row.includes(theme.fg("accent", "42.0%"))));
	assert.ok(!rows.join("").includes(";2;"));
});

test("sidebar aligns telemetry and diff columns, preserves filename ends and click targets", (t) => {
	const h = sidebarHarness();
	t.after(() => h.sidebar.dispose());
	const first = pending("very/long/nested/folder/theme.ts", 18, 6);
	const second = pending("sidebar.ts", 132, 19);
	h.sidebar.publish({ generation: 1, rows: [first, second], changedPaths: new Set([first.path, second.path]) });
	const rendered = h.sidebar.render(36);
	const rows = plain(rendered);
	assert.equal(rows[0], "│ MIDNIGHT / SESSION");
	assert.ok(rows.find((row) => row.includes("CONTEXT (auto)"))?.endsWith("42.0%"));
	assert.equal(rows.find((row) => row.includes("━"))?.match(/━/g)?.length, 14);
	assert.ok(rows.find((row) => row.includes("cost"))?.endsWith("$0.000"));
	const index = rows.findIndex((row) => row.includes("theme.ts"));
	const next = rows.findIndex((row) => row.includes("sidebar.ts"));
	assert.match(rows[index], /….*theme\.ts\s+\+18\s+−6$/);
	assert.equal(rows[index].indexOf("18"), rows[next].indexOf("132") + 1);
	assert.equal(rows[index].indexOf("6"), rows[next].indexOf("19") + 1);
	h.sidebar.handleMouse(click(index));
	assert.equal(h.previews[0], first);
	const model = rows.findIndex((row) => row.includes("model-name"));
	h.sidebar.handleMouse(click(model));
	assert.equal(h.selectedModels, 1);
});

test("sidebar keeps stale, unavailable, conflict, and pressure signals explicit", (t) => {
	const h = sidebarHarness();
	t.after(() => h.sidebar.dispose());
	const conflict = pending("conflict.ts");
	conflict.status = { kind: "u", code: "UU", path: conflict.path, metadata: [] };
	const recorded = { ...pending("recorded.ts"), state: "unavailable" as const };
	h.sidebar.publish({ generation: 1, rows: [conflict, recorded], changedPaths: new Set([conflict.path]) });
	h.sidebar.updating = true;
	assert.ok(h.sidebar.git);
	h.sidebar.git = { ...h.sidebar.git, conflicted: 2 };
	h.sidebar.invalidate();
	const rows = h.sidebar.render(36);
	assert.ok(rows.some((row) => row.includes(h.theme.fg("warning", "Previous snapshot may be stale"))));
	assert.ok(rows.some((row) => row.includes(h.theme.fg("error", "conflict"))));
	assert.ok(rows.some((row) => row.includes(h.theme.fg("error", "2 conflicted"))));
	assert.match(plain(rows).join("\n"), /RECORDED FILES \(1\)/);
	assert.match(plain(rows).join("\n"), /history only · status unavailable/);
	for (const [value, color] of [
		[80, "warning"],
		[95, "error"],
	] as const) {
		h.setPercent(value);
		assert.ok(h.sidebar.render(36).some((row) => row.includes(h.theme.fg(color, `${value.toFixed(1)}%`))));
	}
	for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
		h.setPercent(value);
		assert.doesNotMatch(plain(h.sidebar.render(36)).join("\n"), /NaN|Infinity|━/);
	}
});
