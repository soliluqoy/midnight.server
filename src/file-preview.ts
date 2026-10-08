import { open } from "node:fs/promises";
import { getLanguageFromPath, highlightCode, renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
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

import type { SessionDiffSection } from "./session-diff.ts";

const MAX_PREVIEW_BYTES = 1024 * 1024;
/** A zero byte near the start means we treat the file as binary. */
const BINARY_SNIFF_BYTES = 8192;

export type FilePreviewContent =
	| { kind: "text"; lines: string[] }
	| { kind: "diff"; sections: SessionDiffSection[] }
	| { kind: "message"; text: string };

/** Preview text only. Skip folders, big files, and binary files. */
export async function loadFilePreview(absolutePath: string): Promise<FilePreviewContent> {
	try {
		const file = await open(absolutePath, "r");
		try {
			const stats = await file.stat();
			if (!stats.isFile()) return { kind: "message", text: "Not a regular file." };
			if (stats.size > MAX_PREVIEW_BYTES) return { kind: "message", text: "Too large to preview (limit: 1 MiB)." };
			const buffer = Buffer.alloc(Math.min(stats.size + 1, MAX_PREVIEW_BYTES + 1));
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			if (bytesRead > MAX_PREVIEW_BYTES) return { kind: "message", text: "Too large to preview (limit: 1 MiB)." };
			const bytes = buffer.subarray(0, bytesRead);
			if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: "message", text: "Binary file." };
			const text = stripTerminalSequences(bytes.toString("utf8"))
				.replace(/\r\n?/g, "\n")
				.replace(/\t/g, "    ")
				.replace(/\n$/, "");
			return { kind: "text", lines: text.split("\n") };
		} finally {
			await file.close();
		}
	} catch (error) {
		return { kind: "message", text: error instanceof Error ? error.message : String(error) };
	}
}

export interface FilePreviewOptions {
	theme: () => Theme;
	keybindings: KeybindingsManager;
	/** File path to show in the title. */
	path: string;
	content: FilePreviewContent;
	/** Height in rows, counting the borders too. */
	getHeight: () => number;
	onInsert: () => void;
	onClose: () => void;
}

/** Show a file or diff. You can scroll, but not edit. */
export class FilePreviewComponent implements Component, Focusable {
	focused = false;
	private readonly options: FilePreviewOptions;
	private scrollTop = 0;
	private highlighted: string[] = [];
	private highlightedTheme: Theme | undefined;
	private cache: { width: number; height: number; scrollTop: number; lines: string[] } | undefined;

	constructor(options: FilePreviewOptions) {
		this.options = options;
		this.invalidate();
	}

	invalidate(): void {
		this.cache = undefined;
		const theme = this.options.theme();
		// Keep the same highlighting when only the size or visible rows change.
		if (this.highlightedTheme === theme) return;
		this.highlightedTheme = theme;
		const content = this.options.content;
		if (content.kind === "diff") {
			const label = (text: string) => stripTerminalSequences(text).replace(/\p{Cc}/gu, " ");
			const diff = (text: string) =>
				stripTerminalSequences(text).replace(/\p{Cc}/gu, (char) => (char === "\n" || char === "\t" ? char : ""));
			this.highlighted = content.sections.flatMap((section, index) => [
				...(index ? [""] : []),
				theme.bold(theme.fg("accent", label(section.title))),
				...(section.message ? [theme.fg("muted", label(section.message))] : []),
				...(section.diff ? renderDiff(diff(section.diff), { filePath: this.options.path }).split("\n") : []),
			]);
		} else if (content.kind === "text") {
			const language = getLanguageFromPath(this.options.path);
			this.highlighted = language ? highlightCode(content.lines.join("\n"), language) : content.lines;
		} else this.highlighted = [];
	}

	private bodyHeight(): number {
		return Math.max(1, this.options.getHeight() - 2);
	}

	private lineCount(): number {
		return this.options.content.kind === "message" ? 1 : this.highlighted.length;
	}

	private scrollBy(delta: number): void {
		const maxScroll = Math.max(0, this.lineCount() - this.bodyHeight());
		this.scrollTop = Math.max(0, Math.min(maxScroll, this.scrollTop + delta));
	}

	handleInput(data: string): void {
		const kb = this.options.keybindings;
		if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "app.explorer.preview")) this.options.onClose();
		else if (kb.matches(data, "tui.select.confirm")) this.options.onInsert();
		else if (kb.matches(data, "tui.select.up")) this.scrollBy(-1);
		else if (kb.matches(data, "tui.select.down")) this.scrollBy(1);
		else if (kb.matches(data, "tui.select.pageUp")) this.scrollBy(-this.bodyHeight());
		else if (kb.matches(data, "tui.select.pageDown")) this.scrollBy(this.bodyHeight());
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.scrollBy(event.wheelDelta ?? 0);
			return { handled: true };
		}
		return undefined;
	}

	render(width: number): string[] {
		const theme = this.options.theme();
		if (theme !== this.highlightedTheme) this.invalidate();
		const height = this.options.getHeight();
		if (this.cache?.width === width && this.cache.height === height && this.cache.scrollTop === this.scrollTop)
			return this.cache.lines;
		const keyText = (action: Parameters<KeybindingsManager["getKeys"]>[0]) =>
			this.options.keybindings.getKeys(action).join("/");
		const innerWidth = Math.max(1, width - 4);
		const bodyHeight = this.bodyHeight();
		const borderColor = "borderAccent";
		const pad = (text: string) =>
			`${theme.fg(borderColor, "│")} ${text}${" ".repeat(Math.max(0, innerWidth - visibleWidth(text)))} ${theme.fg(borderColor, "│")}`;

		const content = this.options.content;
		const title = truncateToWidth(
			` ${content.kind === "diff" ? "Session changes · " : ""}${stripTerminalSequences(this.options.path).replace(/\p{Cc}/gu, " ")} `,
			Math.max(1, width - 4),
			"…",
		);
		const lines = [
			theme.fg(borderColor, "╭─") +
				theme.bold(theme.fg("accent", title)) +
				theme.fg(borderColor, `${"─".repeat(Math.max(0, width - 3 - visibleWidth(title)))}╮`),
		];

		if (content.kind === "message") {
			lines.push(pad(theme.fg("muted", truncateToWidth(stripTerminalSequences(content.text), innerWidth, "…"))));
			for (let row = 1; row < bodyHeight; row++) lines.push(pad(""));
		} else {
			this.scrollBy(0);
			const gutterWidth = content.kind === "text" ? String(content.lines.length).length : 0;
			const codeWidth = Math.max(1, innerWidth - (gutterWidth ? gutterWidth + 1 : 0));
			for (let row = 0; row < bodyHeight; row++) {
				const index = this.scrollTop + row;
				const line = this.highlighted[index];
				if (line === undefined) {
					lines.push(pad(""));
					continue;
				}
				const gutter = gutterWidth ? `${theme.fg("dim", String(index + 1).padStart(gutterWidth))} ` : "";
				lines.push(pad(`${gutter}${truncateToWidth(line, codeWidth, theme.fg("dim", "…"))}`));
			}
		}

		const position =
			this.lineCount() > bodyHeight
				? `${this.scrollTop + 1}-${Math.min(this.lineCount(), this.scrollTop + bodyHeight)}/${this.lineCount()}`
				: "";
		const hint = ` ${keyText("tui.select.confirm")} add @file · ${keyText("tui.select.cancel")} close${position ? ` · ${position}` : ""} `;
		const footer = truncateToWidth(hint, Math.max(1, width - 4), "…");
		lines.push(
			theme.fg(borderColor, "╰─") +
				theme.fg("dim", footer) +
				theme.fg(borderColor, `${"─".repeat(Math.max(0, width - 3 - visibleWidth(footer)))}╯`),
		);
		const rendered = lines.map((line) => truncateToWidth(line, width, ""));
		this.cache = { width, height, scrollTop: this.scrollTop, lines: rendered };
		return rendered;
	}
}
