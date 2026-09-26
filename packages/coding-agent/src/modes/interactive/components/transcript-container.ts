import {
	type Component,
	Container,
	dispatchMouseEvent,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ThreadAnchor } from "../../../core/side-threads.ts";

/** Transcript items that side threads can attach to (tool calls, assistant replies). */
export interface ThreadAnchorComponent extends Component {
	getThreadAnchorId(): string | undefined;
	getThreadAnchor(): ThreadAnchor | undefined;
}

export function isThreadAnchorComponent(component: Component): component is ThreadAnchorComponent {
	return (
		typeof (component as Partial<ThreadAnchorComponent>).getThreadAnchorId === "function" &&
		typeof (component as Partial<ThreadAnchorComponent>).getThreadAnchor === "function"
	);
}

/** What the side-thread controller draws into the transcript. */
export interface TranscriptDecorations {
	/** Anchor id of the item highlighted in thread selection mode. Called first in each render. */
	selectedAnchorId(): string | undefined;
	/** Lines drawn under an item: its thread, or nothing. */
	renderBelow(anchorId: string, width: number): string[];
	/** A click on an item's thread lines. */
	onThreadClick(anchorId: string): void;
	/** Alt+click on an item. */
	onAnchorClick(anchorId: string): void;
	/** Drop cached thread lines, e.g. after a theme change. */
	invalidate(): void;
}

interface Row {
	component: Component;
	anchorId: string | undefined;
	start: number;
	itemHeight: number;
	belowHeight: number;
	/** Columns the item was shifted right by the selection gutter. */
	indent: number;
}

const SELECTION_GUTTER_WIDTH = 2;
const OSC133_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

/**
 * The chat transcript. Draws each item's side thread directly below it and a gutter
 * next to the selected item. Threads are not children, so code that adds and removes
 * transcript children is unaffected.
 */
export class TranscriptContainer extends Container {
	decorations: TranscriptDecorations | undefined;
	/** Draws the selection gutter; set by the controller so it can use the theme. */
	gutter: (line: string) => string = (line) => `▌ ${line}`;
	private rows: Row[] = [];
	private lastWidth = 0;

	get renderedWidth(): number {
		return this.lastWidth;
	}

	/** Anchors in transcript order. */
	anchors(): ThreadAnchorComponent[] {
		return this.children.filter(
			(child): child is ThreadAnchorComponent => isThreadAnchorComponent(child) && !!child.getThreadAnchorId(),
		);
	}

	/** First row of an item in the last render, relative to this container. */
	rowOf(anchorId: string): { start: number; height: number } | undefined {
		const row = this.rows.find((candidate) => candidate.anchorId === anchorId);
		return row ? { start: row.start, height: row.itemHeight + row.belowHeight } : undefined;
	}

	override invalidate(): void {
		super.invalidate();
		this.decorations?.invalidate();
	}

	override render(width: number): string[] {
		const decorations = this.decorations;
		if (!decorations) {
			this.rows = [];
			this.lastWidth = width;
			return super.render(width);
		}
		this.lastWidth = width;
		const selected = decorations.selectedAnchorId();
		const lines: string[] = [];
		const rows: Row[] = [];
		for (const child of this.children) {
			const anchorId = isThreadAnchorComponent(child) ? child.getThreadAnchorId() : undefined;
			const isSelected = anchorId !== undefined && anchorId === selected && width > SELECTION_GUTTER_WIDTH + 4;
			const itemLines = isSelected
				? this.withGutter(child.render(width - SELECTION_GUTTER_WIDTH))
				: child.render(width);
			const belowLines = anchorId ? decorations.renderBelow(anchorId, width) : [];
			rows.push({
				component: child,
				anchorId,
				start: lines.length,
				itemHeight: itemLines.length,
				belowHeight: belowLines.length,
				indent: isSelected ? SELECTION_GUTTER_WIDTH : 0,
			});
			for (const line of itemLines) lines.push(line);
			for (const line of belowLines) lines.push(line);
		}
		this.rows = rows;
		return lines;
	}

	private withGutter(lines: string[]): string[] {
		let leading = true;
		return lines.map((line) => {
			if (leading && visibleWidth(line.replace(/\s/g, "")) === 0) return line;
			leading = false;
			const prefix = line.match(OSC133_PREFIX)?.[0] ?? "";
			return prefix + this.gutter(line.slice(prefix.length));
		});
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (!this.decorations || this.rows.length === 0 || event.width !== this.lastWidth) {
			return super.handleMouse(event);
		}
		if (event.y < 0 || event.y >= event.height) return undefined;
		const row = this.rows.find(
			(candidate) =>
				event.y >= candidate.start && event.y < candidate.start + candidate.itemHeight + candidate.belowHeight,
		);
		if (!row) return undefined;
		const localY = event.y - row.start;
		const clicked = event.type === "click" && event.button === "left";
		if (row.anchorId && localY >= row.itemHeight) {
			if (!clicked) return undefined;
			this.decorations.onThreadClick(row.anchorId);
			return this.handled(event, row);
		}
		if (row.anchorId && clicked && event.alt) {
			this.decorations.onAnchorClick(row.anchorId);
			return this.handled(event, row);
		}
		if (event.x < row.indent) return undefined;
		return dispatchMouseEvent(row.component, {
			...event,
			x: event.x - row.indent,
			y: localY,
			width: event.width - row.indent,
			height: row.itemHeight,
		});
	}

	private handled(event: TuiMouseEvent, row: Row): TuiMouseDispatchResult {
		return {
			handled: true,
			render: true,
			target: {
				component: this,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y + row.start,
				width: event.width,
				height: row.itemHeight + row.belowHeight,
			},
		};
	}
}
