import { dirname } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	type KeybindingsManager,
	stripTerminalSequences,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { WorkspaceEntry, WorkspaceFileMark, WorkspaceSnapshot } from "./workspace-files.ts";

/** Width includes the right border. */
export const EXPLORER_WIDTH = 32;
/** Hide below this width in auto mode, leaving about 80 columns for chat with both panels open. */
export const EXPLORER_MIN_TERMINAL_WIDTH = 150;
/** Two rows for the title and folder path. */
const HEADER_ROWS = 2;

export interface FileExplorerOptions {
	theme: () => Theme;
	keybindings: KeybindingsManager;
	onExpand: (path: string) => void;
	/** True only at the project root, not a folder inside it or elsewhere. */
	isProjectRoot: () => boolean;
	rootPath: () => string;
	/** Files touched in this session that still have changes. Paths start at the shown folder. */
	sessionChanges: () => ReadonlySet<string>;
	/** Use the full terminal height. */
	getHeight: () => number;
	/** Enter or double-click adds the file path to the prompt. */
	onOpen: (path: string) => void;
	onPreview: (path: string) => void;
	onFolder: () => void;
	onParent: () => void;
	onProject: () => void;
	/** Escape returns to the prompt. */
	onExit: () => void;
	/** Toggle key pressed while browsing files. */
	onToggle: () => void;
	/** Send unused keys to the prompt so typing is not lost. */
	onPassthrough: (data: string) => void;
}

interface ExplorerRow {
	entry: WorkspaceEntry;
	depth: number;
	/** Go up a folder. Do not load this row or add it to the prompt. */
	parent?: boolean;
}

function markColor(mark: WorkspaceFileMark): "toolDiffAdded" | "toolDiffRemoved" | "warning" | "error" | "muted" {
	if (mark === "A" || mark === "?") return "toolDiffAdded";
	if (mark === "D") return "toolDiffRemoved";
	if (mark === "U") return "error";
	if (mark === "M") return "warning";
	return "muted";
}

function parentPath(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

/** Keep the end of a long path so the file or folder name stays visible. */
export function truncateLeftToWidth(text: string, maxWidth: number, ellipsis = "…"): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	const ellipsisWidth = visibleWidth(ellipsis);
	const targetWidth = maxWidth - ellipsisWidth;
	if (targetWidth <= 0) return truncateToWidth(ellipsis, maxWidth, ellipsis);
	const chars = Array.from(text);
	const kept: string[] = [];
	let width = 0;
	for (let index = chars.length - 1; index >= 0; index--) {
		const char = chars[index];
		if (char === undefined) break;
		const charWidth = visibleWidth(char);
		if (width + charWidth > targetWidth) break;
		width += charWidth;
		kept.unshift(char);
	}
	return `${ellipsis}${kept.join("")}`;
}

/** File tree on the left. Send normal typing back to the prompt. */
export class FileExplorerComponent implements Component, Focusable {
	focused = false;
	private readonly options: FileExplorerOptions;
	private snapshot: WorkspaceSnapshot | undefined;
	private readonly expanded = new Set<string>();
	private selectedPath: string | undefined;
	private scrollTop = 0;
	private rows: ExplorerRow[] = [];
	private indices = new Map<string, number>();
	private cache:
		| { width: number; height: number; focused: boolean; changes: ReadonlySet<string>; lines: string[] }
		| undefined;

	constructor(options: FileExplorerOptions) {
		this.options = options;
	}

	setSnapshot(snapshot: WorkspaceSnapshot, reset = false): void {
		if (reset) {
			this.expanded.clear();
			this.selectedPath = undefined;
			this.scrollTop = 0;
		}
		this.snapshot = snapshot;
		this.rows = this.buildRows();
		this.invalidate();
	}

	getSelectedPath(): string | undefined {
		return this.selectedPath;
	}

	/** List open folders, but skip those inside closed folders. */
	getExpandedDirectories(): string[] {
		return [
			"",
			...this.rows
				.filter((row) => !row.parent && row.entry.directory && this.expanded.has(row.entry.path))
				.map((row) => row.entry.path),
		];
	}

	invalidate(): void {
		this.cache = undefined;
	}

	private buildRows(): ExplorerRow[] {
		const rows: ExplorerRow[] = [];
		this.indices.clear();
		const root = this.options.rootPath();
		if (dirname(root) !== root) {
			this.indices.set("..", 0);
			rows.push({ entry: { name: ".. (parent folder)", path: "..", directory: true }, depth: 0, parent: true });
		}
		const snapshot = this.snapshot;
		if (!snapshot) return rows;
		const visit = (dir: string, depth: number) => {
			for (const entry of snapshot.children(dir)) {
				this.indices.set(entry.path, rows.length);
				rows.push({ entry, depth });
				if (entry.directory && this.expanded.has(entry.path)) visit(entry.path, depth + 1);
			}
		};
		visit("", 0);
		return rows;
	}

	private selectedIndex(): number {
		return this.selectedPath === undefined ? 0 : (this.indices.get(this.selectedPath) ?? 0);
	}

	private hints(): string[] {
		const key = (action: Parameters<KeybindingsManager["getKeys"]>[0]) => {
			const binding = this.options.keybindings.getKeys(action)[0] ?? "";
			return binding === "escape" ? "esc" : binding;
		};
		if (!this.focused) return [`${key("app.explorer.toggle")} browse`];
		return [
			`${key("tui.select.confirm")} @file · ${key("app.explorer.preview")} preview`,
			`${key("app.explorer.folder")} locations · ${key("tui.select.cancel")} prompt`,
			...(this.options.isProjectRoot() ? [] : [`${key("app.explorer.project")} project`]),
		];
	}

	private treeHeight(): number {
		return Math.max(1, this.options.getHeight() - HEADER_ROWS - 1 - this.hints().length);
	}

	private select(index: number): void {
		if (this.rows.length === 0) return;
		const clamped = Math.max(0, Math.min(this.rows.length - 1, index));
		this.selectedPath = this.rows[clamped]?.entry.path;
	}

	private toggleDirectory(path: string): void {
		if (this.expanded.has(path)) this.expanded.delete(path);
		else this.expanded.add(path);
		this.rows = this.buildRows();
		// Folders inside a reopened folder may need fresh lists too.
		for (const directory of this.getExpandedDirectories()) this.options.onExpand(directory);
	}

	handleInput(data: string): void {
		this.invalidate();
		const kb = this.options.keybindings;
		const index = this.selectedIndex();
		const row = this.rows[index];
		if (kb.matches(data, "app.explorer.toggle")) this.options.onToggle();
		else if (kb.matches(data, "tui.select.cancel")) this.options.onExit();
		else if (kb.matches(data, "app.explorer.folder")) this.options.onFolder();
		else if (kb.matches(data, "app.explorer.parent")) this.options.onParent();
		else if (kb.matches(data, "app.explorer.project")) this.options.onProject();
		else if (kb.matches(data, "tui.select.up")) this.select(index - 1);
		else if (kb.matches(data, "tui.select.down")) this.select(index + 1);
		else if (kb.matches(data, "tui.select.pageUp")) this.select(index - this.treeHeight());
		else if (kb.matches(data, "tui.select.pageDown")) this.select(index + this.treeHeight());
		else if (kb.matches(data, "app.explorer.expand")) {
			if (!row) return;
			if (row.parent) this.options.onParent();
			else if (!row.entry.directory) this.options.onPreview(row.entry.path);
			else if (!this.expanded.has(row.entry.path)) this.toggleDirectory(row.entry.path);
			else this.select(index + 1);
		} else if (kb.matches(data, "app.explorer.collapse")) {
			if (!row || row.parent) return;
			if (row.entry.directory && this.expanded.has(row.entry.path)) this.toggleDirectory(row.entry.path);
			else if (row.depth > 0) this.selectedPath = parentPath(row.entry.path);
		} else if (kb.matches(data, "tui.select.confirm")) {
			if (!row) return;
			if (row.parent) this.options.onParent();
			else if (row.entry.directory) this.toggleDirectory(row.entry.path);
			else this.options.onOpen(row.entry.path);
		} else if (kb.matches(data, "app.explorer.preview")) {
			if (!row) return;
			if (row.parent) this.options.onParent();
			else if (row.entry.directory) this.toggleDirectory(row.entry.path);
			else this.options.onPreview(row.entry.path);
		} else this.options.onPassthrough(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.invalidate();
			const maxScroll = Math.max(0, this.rows.length - this.treeHeight());
			this.scrollTop = Math.max(0, Math.min(maxScroll, this.scrollTop + (event.wheelDelta ?? 0)));
			this.select(Math.max(this.scrollTop, Math.min(this.selectedIndex(), this.scrollTop + this.treeHeight() - 1)));
			return { handled: true };
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.invalidate();
		const row = this.rows[this.scrollTop + event.y - HEADER_ROWS];
		if (event.y < HEADER_ROWS || event.y >= HEADER_ROWS + this.treeHeight() || !row)
			return { handled: true, focus: true };
		this.selectedPath = row.entry.path;
		if (row.parent) this.options.onParent();
		else if (row.entry.directory) this.toggleDirectory(row.entry.path);
		else if ((event.clickCount ?? 1) >= 2) {
			this.options.onOpen(row.entry.path);
			return { handled: true };
		}
		return { handled: true, focus: true };
	}

	private renderRow(row: ExplorerRow, selected: boolean, width: number, sessionChanges: ReadonlySet<string>): string {
		const theme = this.options.theme();
		const { entry, depth } = row;
		const snapshot = this.snapshot;
		const mark = row.parent ? undefined : snapshot?.mark(entry.path);
		const changedBySession = !entry.directory && sessionChanges.has(entry.path);
		const indent = "  ".repeat(depth);
		const icon = row.parent ? "↑ " : entry.directory ? (this.expanded.has(entry.path) ? "▾ " : "▸ ") : "  ";
		let suffix = "";
		if (mark) suffix = theme.fg(markColor(mark), mark);
		else if (!row.parent && entry.directory && snapshot?.containsMarks(entry.path)) suffix = theme.fg("dim", "•");
		if (changedBySession) suffix = `${theme.fg("accent", "●")}${suffix ? ` ${suffix}` : ""}`;
		const suffixWidth = visibleWidth(suffix);
		const ignored = !row.parent && (snapshot?.isIgnored(entry.path) ?? false);
		const nameColor = row.parent ? "dim" : ignored || mark === "D" ? "dim" : "text";
		const nameWidth = Math.max(1, width - suffixWidth - (suffixWidth > 0 ? 1 : 0));
		const name = truncateToWidth(
			`${theme.fg("dim", indent + icon)}${theme.fg(nameColor, stripTerminalSequences(entry.name))}`,
			nameWidth,
			theme.fg("dim", "…"),
		);
		const line = `${name}${" ".repeat(Math.max(0, width - visibleWidth(name) - suffixWidth))}${suffix}`;
		if (!selected) return line;
		return this.focused ? theme.bg("selectedBg", line) : theme.bold(line);
	}

	render(width: number): string[] {
		const requestedHeight = this.options.getHeight();
		const sessionChanges = this.options.sessionChanges();
		if (
			this.cache?.width === width &&
			this.cache.height === requestedHeight &&
			this.cache.focused === this.focused &&
			this.cache.changes === sessionChanges
		)
			return this.cache.lines;
		const theme = this.options.theme();
		const hints = this.hints();
		// Leave room for a space and the right border.
		const contentWidth = Math.max(1, width - 2);
		const footerRows = 1 + hints.length;
		const height = Math.max(HEADER_ROWS + footerRows + 1, this.options.getHeight());
		const treeHeight = height - HEADER_ROWS - footerRows;
		if (this.selectedPath === undefined && this.rows.length > 0)
			this.selectedPath = (this.rows.find((row) => !row.parent) ?? this.rows[0])?.entry.path;
		const selected = this.selectedIndex();
		if (selected < this.scrollTop) this.scrollTop = selected;
		else if (selected >= this.scrollTop + treeHeight) this.scrollTop = selected - treeHeight + 1;
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, this.rows.length - treeHeight)));

		const lines: string[] = [];
		const titleColor = this.focused ? "accent" : "muted";
		lines.push(
			truncateToWidth(
				theme.bold(theme.fg(titleColor, "EXPLORER")) +
					(this.options.isProjectRoot() ? "" : theme.fg("dim", " [external]")),
				contentWidth,
				theme.fg("dim", "…"),
			),
		);
		lines.push(
			theme.fg("dim", truncateLeftToWidth(stripTerminalSequences(this.options.rootPath()), contentWidth, "…")),
		);
		const error = this.snapshot?.error?.("");
		for (let offset = 0; offset < treeHeight; offset++) {
			const row = this.rows[this.scrollTop + offset];
			if (!row) break;
			lines.push(this.renderRow(row, this.scrollTop + offset === selected, contentWidth, sessionChanges));
		}
		const message =
			error ?? (!this.snapshot ? "loading…" : this.rows.some((row) => !row.parent) ? undefined : "no files");
		if (message && lines.length < HEADER_ROWS + treeHeight)
			lines.push(
				truncateToWidth(theme.fg(error ? "warning" : "dim", stripTerminalSequences(message)), contentWidth, "…"),
			);
		while (lines.length < height - hints.length) lines.push("");
		for (const hint of hints) lines.push(truncateToWidth(theme.fg("dim", hint), contentWidth, theme.fg("dim", "…")));

		const border = theme.fg(this.focused ? "borderAccent" : "borderMuted", "│");
		const rendered = lines
			.slice(0, Math.max(1, this.options.getHeight()))
			.map((line) =>
				truncateToWidth(`${line}${" ".repeat(Math.max(0, contentWidth - visibleWidth(line)))} ${border}`, width, ""),
			);
		this.cache = { width, height: requestedHeight, focused: this.focused, changes: sessionChanges, lines: rendered };
		return rendered;
	}
}
