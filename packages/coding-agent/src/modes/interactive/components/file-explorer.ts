import {
	type Component,
	type Focusable,
	getKeybindings,
	type Keybinding,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { WorkspaceEntry, WorkspaceFileMark, WorkspaceSnapshot } from "../../../core/workspace-files.ts";
import { theme } from "../theme/theme.ts";
import { formatKeyText } from "./keybinding-hints.ts";

/** Explorer width including its right border column. */
export const EXPLORER_WIDTH = 32;
/**
 * Below this terminal width the explorer hides in `auto` mode. It is wider than the sidebar
 * threshold so the transcript keeps about 80 columns with both panels open.
 */
export const EXPLORER_MIN_TERMINAL_WIDTH = 150;
/** Title row plus a blank row above the tree. */
const HEADER_ROWS = 2;
/** Blank row plus two key hint rows below the tree. */
const FOOTER_ROWS = 3;

export interface FileExplorerOptions {
	/** Workspace folder name shown in the title. */
	rootName: () => string;
	/** Paths changed by the agent in this session, relative to the workspace root. */
	sessionChanges: () => ReadonlySet<string>;
	/** Terminal height; the explorer fills the full column. */
	getHeight: () => number;
	/** Enter on a file (or a double click): reference it in the prompt. */
	onOpen: (path: string) => void;
	onPreview: (path: string) => void;
	/** Escape: give focus back to the prompt. */
	onExit: () => void;
	/** The explorer toggle key while the explorer has focus. */
	onToggle: () => void;
	/** Keys the explorer does not use, so typing always lands in the prompt. */
	onPassthrough: (data: string) => void;
}

interface ExplorerRow {
	entry: WorkspaceEntry;
	depth: number;
}

function markColor(mark: WorkspaceFileMark): "toolDiffAdded" | "toolDiffRemoved" | "warning" | "error" | "muted" {
	if (mark === "A" || mark === "?") return "toolDiffAdded";
	if (mark === "D") return "toolDiffRemoved";
	if (mark === "U") return "error";
	if (mark === "M") return "warning";
	return "muted";
}

/** First key bound to an action; the full list does not fit the narrow column. */
function firstKey(keybinding: Keybinding): string {
	return formatKeyText(getKeybindings().getKeys(keybinding)[0] ?? "");
}

function parentPath(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

/**
 * Left-hand workspace tree for the fullscreen TUI. It only reacts to navigation keys; any other
 * key is passed back to the prompt, so typing while the tree has focus is never lost.
 */
export class FileExplorerComponent implements Component, Focusable {
	focused = false;
	private readonly options: FileExplorerOptions;
	private snapshot: WorkspaceSnapshot | undefined;
	private readonly expanded = new Set<string>();
	private selectedPath: string | undefined;
	private scrollTop = 0;
	private rows: ExplorerRow[] = [];

	constructor(options: FileExplorerOptions) {
		this.options = options;
	}

	setSnapshot(snapshot: WorkspaceSnapshot): void {
		this.snapshot = snapshot;
	}

	getSelectedPath(): string | undefined {
		return this.selectedPath;
	}

	invalidate(): void {}

	private buildRows(): ExplorerRow[] {
		const rows: ExplorerRow[] = [];
		const snapshot = this.snapshot;
		if (!snapshot) return rows;
		const visit = (dir: string, depth: number) => {
			for (const entry of snapshot.children(dir)) {
				rows.push({ entry, depth });
				if (entry.directory && this.expanded.has(entry.path)) visit(entry.path, depth + 1);
			}
		};
		visit("", 0);
		return rows;
	}

	private selectedIndex(): number {
		const index = this.rows.findIndex((row) => row.entry.path === this.selectedPath);
		return index === -1 ? 0 : index;
	}

	private treeHeight(): number {
		return Math.max(1, this.options.getHeight() - HEADER_ROWS - FOOTER_ROWS);
	}

	private select(index: number): void {
		if (this.rows.length === 0) return;
		const clamped = Math.max(0, Math.min(this.rows.length - 1, index));
		this.selectedPath = this.rows[clamped]!.entry.path;
	}

	private toggleDirectory(path: string): void {
		if (this.expanded.has(path)) this.expanded.delete(path);
		else this.expanded.add(path);
		this.rows = this.buildRows();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		this.rows = this.buildRows();
		const index = this.selectedIndex();
		const row = this.rows[index];
		if (kb.matches(data, "app.explorer.toggle")) this.options.onToggle();
		else if (kb.matches(data, "tui.select.cancel")) this.options.onExit();
		else if (kb.matches(data, "tui.select.up")) this.select(index - 1);
		else if (kb.matches(data, "tui.select.down")) this.select(index + 1);
		else if (kb.matches(data, "app.explorer.expand")) {
			if (!row) return;
			if (!row.entry.directory) this.options.onPreview(row.entry.path);
			else if (!this.expanded.has(row.entry.path)) this.toggleDirectory(row.entry.path);
			else this.select(index + 1);
		} else if (kb.matches(data, "app.explorer.collapse")) {
			if (!row) return;
			if (row.entry.directory && this.expanded.has(row.entry.path)) this.toggleDirectory(row.entry.path);
			else if (row.depth > 0) this.selectedPath = parentPath(row.entry.path);
		} else if (kb.matches(data, "tui.select.confirm")) {
			if (!row) return;
			if (row.entry.directory) this.toggleDirectory(row.entry.path);
			else this.options.onOpen(row.entry.path);
		} else if (kb.matches(data, "app.explorer.preview")) {
			if (!row) return;
			if (row.entry.directory) this.toggleDirectory(row.entry.path);
			else this.options.onPreview(row.entry.path);
		} else this.options.onPassthrough(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			const maxScroll = Math.max(0, this.rows.length - this.treeHeight());
			this.scrollTop = Math.max(0, Math.min(maxScroll, this.scrollTop + (event.wheelDelta ?? 0)));
			return { handled: true };
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		const row = this.rows[this.scrollTop + event.y - HEADER_ROWS];
		if (event.y < HEADER_ROWS || !row) return { handled: true, focus: true };
		this.selectedPath = row.entry.path;
		if (row.entry.directory) this.toggleDirectory(row.entry.path);
		else if ((event.clickCount ?? 1) >= 2) this.options.onOpen(row.entry.path);
		return { handled: true, focus: true };
	}

	private renderRow(row: ExplorerRow, selected: boolean, width: number, sessionChanges: ReadonlySet<string>): string {
		const { entry, depth } = row;
		const snapshot = this.snapshot;
		const mark = snapshot?.mark(entry.path);
		const changedBySession = !entry.directory && sessionChanges.has(entry.path);
		const indent = "  ".repeat(depth);
		const icon = entry.directory ? (this.expanded.has(entry.path) ? "▾ " : "▸ ") : "  ";
		let suffix = "";
		if (mark) suffix = theme.fg(markColor(mark), mark);
		else if (entry.directory && snapshot?.containsMarks(entry.path)) suffix = theme.fg("dim", "•");
		if (changedBySession) suffix = `${theme.fg("accent", "●")}${suffix ? ` ${suffix}` : ""}`;
		const suffixWidth = visibleWidth(suffix);
		const ignored = snapshot?.isIgnored(entry.path) ?? false;
		const nameColor = ignored || mark === "D" ? "dim" : entry.directory ? "accent" : "text";
		const nameWidth = Math.max(1, width - suffixWidth - (suffixWidth > 0 ? 1 : 0));
		const name = truncateToWidth(
			`${theme.fg("dim", indent + icon)}${theme.fg(nameColor, entry.name)}`,
			nameWidth,
			theme.fg("dim", "…"),
		);
		const line = `${name}${" ".repeat(Math.max(0, width - visibleWidth(name) - suffixWidth))}${suffix}`;
		if (!selected) return line;
		return this.focused ? theme.bg("selectedBg", line) : theme.bold(line);
	}

	render(width: number): string[] {
		// Content, a one-column gap, then the right border.
		const contentWidth = Math.max(1, width - 2);
		const height = Math.max(HEADER_ROWS + FOOTER_ROWS + 1, this.options.getHeight());
		const treeHeight = height - HEADER_ROWS - FOOTER_ROWS;
		this.rows = this.buildRows();
		if (this.selectedPath === undefined && this.rows.length > 0) this.selectedPath = this.rows[0]!.entry.path;
		const selected = this.selectedIndex();
		if (selected < this.scrollTop) this.scrollTop = selected;
		else if (selected >= this.scrollTop + treeHeight) this.scrollTop = selected - treeHeight + 1;
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, this.rows.length - treeHeight)));

		const lines: string[] = [];
		const titleColor = this.focused ? "accent" : "muted";
		lines.push(
			truncateToWidth(
				`${theme.bold(theme.fg(titleColor, "EXPLORER"))} ${theme.fg("dim", this.options.rootName())}`,
				contentWidth,
				theme.fg("dim", "…"),
			),
		);
		lines.push("");
		const sessionChanges = this.options.sessionChanges();
		if (!this.snapshot) lines.push(theme.fg("dim", "loading…"));
		else if (this.rows.length === 0) lines.push(theme.fg("dim", "no files"));
		for (let offset = 0; offset < treeHeight; offset++) {
			const row = this.rows[this.scrollTop + offset];
			if (!row) break;
			lines.push(this.renderRow(row, this.scrollTop + offset === selected, contentWidth, sessionChanges));
		}
		while (lines.length < height - 2) lines.push("");
		const hints = this.focused
			? [
					`${firstKey("tui.select.confirm")} @file · ${firstKey("app.explorer.preview")} preview`,
					`${firstKey("tui.select.cancel")} back to prompt`,
				]
			: ["", `${firstKey("app.explorer.toggle")} to browse`];
		for (const hint of hints) lines.push(truncateToWidth(theme.fg("dim", hint), contentWidth, theme.fg("dim", "…")));

		const border = theme.fg(this.focused ? "borderAccent" : "borderMuted", "│");
		return lines.map((line) => `${line}${" ".repeat(Math.max(0, contentWidth - visibleWidth(line)))} ${border}`);
	}
}
