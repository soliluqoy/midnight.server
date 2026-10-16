import assert from "node:assert/strict";
import { test } from "node:test";
import { type Component, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { SidebarLayout } from "../src/layout.ts";

// Mirrors the viewport marker Pi's own HStack layout uses.
const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");
const panel = (text: string): Component => ({ render: () => [text], invalidate: () => {} });

function mountLayout(
	columns: number,
	explorerMode: "auto" | "always" | "hidden",
	sidebarMode: "auto" | "always" | "hidden" = "always",
): Component {
	let mounted: Component | undefined;
	const root = panel("root");
	const tui = {
		[VIEWPORT_TUI]: true,
		terminal: { columns, rows: 24 },
		layoutRoot: root,
		setLayoutRoot(value: Component) {
			mounted = value;
		},
	};
	const layout = new SidebarLayout(tui as unknown as TUI, panel("SIDEBAR"), panel("EXPLORER"));
	layout.explorerMode = explorerMode;
	layout.sidebarMode = sidebarMode;
	assert.equal(layout.ensure(), true);
	assert.ok(mounted);
	return mounted;
}

test("the main pane keeps its left gutter while Explorer is closed, even with the sidebar open", () => {
	const first = (width: number, explorer: "auto" | "always" | "hidden", sidebar: "always" | "hidden") =>
		stripTerminalSequences(mountLayout(width, explorer, sidebar).render(width)[0]);
	assert.equal(first(180, "hidden", "always").indexOf("root"), 4);
	assert.equal(first(180, "hidden", "hidden").indexOf("root"), 4);
	assert.equal(first(180, "always", "always").indexOf("root"), 32);
	assert.equal(first(80, "auto", "always").indexOf("root"), 4);
});
