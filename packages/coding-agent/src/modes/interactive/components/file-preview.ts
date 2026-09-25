import { closeSync, openSync, readSync, statSync } from "node:fs";
import {
	type Component,
	type Focusable,
	getKeybindings,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { replaceTabs } from "../../../core/tools/render-utils.ts";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/** Files larger than this are not previewed. */
const MAX_PREVIEW_BYTES = 1024 * 1024;
/** A NUL byte in this prefix marks the file as binary. */
const BINARY_SNIFF_BYTES = 8192;

export type FilePreviewContent = { kind: "text"; lines: string[] } | { kind: "message"; text: string };

/** Read a file for preview, refusing directories, large files, and binary content. */
export function loadFilePreview(absolutePath: string): FilePreviewContent {
	let size: number;
	try {
		const stats = statSync(absolutePath);
		if (!stats.isFile()) return { kind: "message", text: "Not a regular file." };
		size = stats.size;
	} catch {
		return { kind: "message", text: "File not found (deleted from disk?)." };
	}
	if (size > MAX_PREVIEW_BYTES) {
		return { kind: "message", text: `Too large to preview (${Math.round(size / 1024)} KB).` };
	}
	const buffer = Buffer.alloc(size);
	try {
		const fd = openSync(absolutePath, "r");
		try {
			readSync(fd, buffer, 0, size, 0);
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		return { kind: "message", text: `Cannot read file: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: "message", text: "Binary file." };
	const text = replaceTabs(buffer.toString("utf8").replace(/\r\n?/g, "\n")).replace(/\n$/, "");
	const lang = getLanguageFromPath(absolutePath);
	return { kind: "text", lines: lang ? highlightCode(text, lang) : text.split("\n") };
}

export interface FilePreviewOptions {
	/** Workspace-relative path shown in the title. */
	path: string;
	content: FilePreviewContent;
	/** Total overlay height in rows, including borders. */
	getHeight: () => number;
	onInsert: () => void;
	onClose: () => void;
}

/** Read-only, scrollable file view shown as an overlay from the file explorer. */
export class FilePreviewComponent implements Component, Focusable {
	focused = false;
	private readonly options: FilePreviewOptions;
	private scrollTop = 0;

	constructor(options: FilePreviewOptions) {
		this.options = options;
	}

	invalidate(): void {}

	private bodyHeight(): number {
		return Math.max(1, this.options.getHeight() - 2);
	}

	private lineCount(): number {
		return this.options.content.kind === "text" ? this.options.content.lines.length : 1;
	}

	private scrollBy(delta: number): void {
		const maxScroll = Math.max(0, this.lineCount() - this.bodyHeight());
		this.scrollTop = Math.max(0, Math.min(maxScroll, this.scrollTop + delta));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
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
		const innerWidth = Math.max(1, width - 4);
		const bodyHeight = this.bodyHeight();
		const borderColor = "borderAccent";
		const pad = (text: string) =>
			`${theme.fg(borderColor, "│")} ${text}${" ".repeat(Math.max(0, innerWidth - visibleWidth(text)))} ${theme.fg(borderColor, "│")}`;

		const title = truncateToWidth(` ${this.options.path} `, Math.max(1, width - 4), "…");
		const lines = [
			theme.fg(borderColor, "╭─") +
				theme.bold(theme.fg("accent", title)) +
				theme.fg(borderColor, `${"─".repeat(Math.max(0, width - 3 - visibleWidth(title)))}╮`),
		];

		const content = this.options.content;
		if (content.kind === "message") {
			lines.push(pad(theme.fg("muted", truncateToWidth(content.text, innerWidth, "…"))));
			for (let row = 1; row < bodyHeight; row++) lines.push(pad(""));
		} else {
			this.scrollBy(0);
			const gutterWidth = String(content.lines.length).length;
			const codeWidth = Math.max(1, innerWidth - gutterWidth - 1);
			for (let row = 0; row < bodyHeight; row++) {
				const index = this.scrollTop + row;
				const line = content.lines[index];
				if (line === undefined) {
					lines.push(pad(""));
					continue;
				}
				const number = theme.fg("dim", String(index + 1).padStart(gutterWidth));
				lines.push(pad(`${number} ${truncateToWidth(line, codeWidth, theme.fg("dim", "…"))}`));
			}
		}

		const position =
			content.kind === "text" && content.lines.length > bodyHeight
				? `${this.scrollTop + 1}-${Math.min(content.lines.length, this.scrollTop + bodyHeight)}/${content.lines.length}`
				: "";
		const hint = ` ${keyText("tui.select.confirm")} add @file · ${keyText("tui.select.cancel")} close${position ? ` · ${position}` : ""} `;
		const footer = truncateToWidth(hint, Math.max(1, width - 4), "…");
		lines.push(
			theme.fg(borderColor, "╰─") +
				theme.fg("dim", footer) +
				theme.fg(borderColor, `${"─".repeat(Math.max(0, width - 3 - visibleWidth(footer)))}╯`),
		);
		return lines;
	}
}
