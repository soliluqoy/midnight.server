import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
	type AgentSession,
	FooterComponent,
	type ReadonlyFooterDataProvider,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	ProcessTerminal,
	stripTerminalSequences,
	Text,
	TuiAltScreen,
	TuiMainScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { initTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { focusedComponent, SidebarLayout } from "../src/layout.ts";
import { SessionAnalysis, sessionEntryCount } from "../src/session-analysis.ts";

const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

// No terminal is started and no real terminal input/output is used.
function terminal() {
	const result = new ProcessTerminal();
	Object.defineProperties(result, { columns: { value: 160, writable: true }, rows: { value: 40 } });
	return result;
}

test("installed Pi and lockfile match both supported peer pins", async () => {
	const json = async (name: string) => JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));
	const manifest = await json("../package.json");
	const lock = await json("../package-lock.json");
	for (const name of ["pi-coding-agent", "pi-tui"]) {
		const peer = `@earendil-works/${name}`;
		const installed = await json(`../node_modules/${peer}/package.json`);
		assert.equal(manifest.peerDependencies[peer], "1.2.0");
		assert.equal(installed.version, manifest.peerDependencies[peer]);
		assert.equal(lock.packages[""].peerDependencies[peer], installed.version);
		assert.equal(lock.packages[`node_modules/${peer}`].version, installed.version);
	}
});

test("supported Pi fullscreen tree mounts panels, filters its real footer, and restores on dispose", () => {
	initTheme("dark", false);
	const cwd = path.resolve("midnight-compatibility");
	const manager = SessionManager.inMemory(cwd);
	manager.appendSessionInfo("Compatibility session");
	manager.appendUsage("test", "test", "test", {
		input: 100,
		output: 50,
		cacheRead: 64,
		cacheWrite: 0,
		totalTokens: 214,
		cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
	});
	const session = {
		sessionManager: manager,
		state: {},
		getContextUsage: () => ({ tokens: 42000, percent: 42, contextWindow: 100000 }),
	} as unknown as AgentSession;
	const data: ReadonlyFooterDataProvider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map([["test", "custom status"]]),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
	const footer = new FooterComponent(session, data);
	const render = footer.render;
	const baseline = footer.render(100);
	assert.match(plain(baseline), /Compatibility session/);
	assert.match(plain(baseline), /↑100.*↓50.*R64.*\$0\.300.*42\.0%\/100k/);
	const footerContainer = new Container();
	footerContainer.addChild(footer);
	const editor = new Text("editor draft");
	const widget = new Text("custom widget");
	const { root, transcript } = createChatViewport({
		document: new Text("transcript"),
		pendingMessages: new Container(),
		status: new Container(),
		widgetsAbove: widget,
		editor,
		footer: footerContainer,
	});
	assert.ok(root instanceof Container);
	const originalChildren = [...root.children];
	const term = terminal();
	const tui = new TuiAltScreen(term);
	tui.setLayoutRoot(root);
	tui.setFocus(editor);
	const layout = new SidebarLayout(tui, new Text("sidebar"), new Text("explorer"), () => cwd);
	assert.equal(layout.ensure(), true);
	assert.equal(layout.ensure(), true, "mounting is idempotent");
	assert.deepEqual(layout.visibility(), { sidebar: true, explorer: true });
	assert.equal(layout.autoCompactEnabled(), true);
	assert.equal(focusedComponent(tui), editor);
	const mounted = plain(tui.render(160));
	for (const label of ["sidebar", "explorer", "editor draft", "custom widget", "custom status"])
		assert.ok(mounted.includes(label), label);
	// Direct component rendering has no height allocation for the grow-only transcript.
	assert.match(plain(transcript.render(100)), /transcript/);
	assert.deepEqual(root.children, originalChildren, "the original fullscreen tree is preserved");
	const filtered = plain(footer.render(100));
	assert.match(filtered, /R64/);
	assert.match(filtered, /custom status/);
	assert.doesNotMatch(filtered, /Compatibility session|↑100|↓50|\$0\.300|42\.0%|no-model/);
	assert.equal(manager.getSessionName(), "Compatibility session", "shared session data is unchanged");
	assert.equal(data.getGitBranch(), "main");
	for (const width of [1, 24, 80, 100]) assert.ok(footer.render(width).every((line) => visibleWidth(line) <= width));
	footer.setAutoCompactEnabled(false);
	assert.equal(layout.autoCompactEnabled(), false);
	footer.setAutoCompactEnabled(true);
	Object.defineProperty(term, "columns", { value: 70 });
	assert.deepEqual(layout.visibility(), { sidebar: false, explorer: false });
	assert.deepEqual(footer.render(100), baseline, "hidden panels leave normal footer content");
	layout.dispose();
	layout.dispose();
	assert.equal(Reflect.get(tui, "layoutRoot"), root);
	assert.equal(Reflect.get(footer, "footerData"), data);
	assert.equal(footer.render, render);
	assert.deepEqual(footer.render(100), baseline);
	assert.equal(focusedComponent(tui), editor);
	assert.equal(layout.ensure(), false);
});

test("regular and unknown fullscreen roots are left alone; disposal preserves replacement layouts", () => {
	const sidebar = new Text("sidebar");
	const explorer = new Text("explorer");
	const regular = new TuiMainScreen(terminal());
	const regularLayout = new SidebarLayout(regular, sidebar, explorer);
	assert.equal(regularLayout.ensure(), false);
	assert.deepEqual(regularLayout.visibility(), { sidebar: false, explorer: false });
	regularLayout.dispose();
	const fullscreen = new TuiAltScreen(terminal());
	const layout = new SidebarLayout(fullscreen, sidebar, explorer);
	assert.equal(layout.ensure(), false, "no explicit fullscreen root");
	const unknown = { render: () => [] };
	Reflect.set(fullscreen, "layoutRoot", unknown);
	assert.equal(layout.ensure(), false, "unknown component shape");
	assert.equal(Reflect.get(fullscreen, "layoutRoot"), unknown);
	const root = new Container();
	fullscreen.setLayoutRoot(root);
	assert.equal(layout.ensure(), true);
	const replacement = new Container();
	fullscreen.setLayoutRoot(replacement);
	layout.dispose();
	assert.equal(Reflect.get(fullscreen, "layoutRoot"), replacement);
});

test("supported Pi exposes guarded entry counts and session analysis avoids repeat scans", () => {
	const manager = SessionManager.inMemory();
	assert.equal(sessionEntryCount(manager), manager.getEntryCount());
	const analysis = new SessionAnalysis();
	analysis.update(manager, manager.getCwd());
	let scans = 0;
	const entries = manager.getEntries.bind(manager);
	manager.getEntries = () => {
		scans++;
		return entries();
	};
	analysis.update(manager, manager.getCwd());
	manager.appendSessionInfo("New session name");
	analysis.update(manager, manager.getCwd());
	assert.equal(scans, 0, "unchanged and appended entries do not trigger a full scan");
	assert.equal(sessionEntryCount(manager), manager.getEntryCount());
	Reflect.set(manager, "getEntryCount", undefined);
	assert.equal(sessionEntryCount(manager), undefined);
});
