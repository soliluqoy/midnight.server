import {
	type Component,
	HStack,
	ScrollView,
	type ScrollViewScrollbar,
	type StackEntry,
	type StackEntryOptions,
	VStack,
} from "@earendil-works/pi-tui";

export interface ChatViewportOptions {
	readonly document: Component;
	readonly pendingMessages: Component;
	readonly status: Component;
	readonly editor: Component;
	readonly footer: Component;
	readonly widgetsAbove?: Component;
	readonly widgetsBelow?: Component;
	readonly scrollbar?: ScrollViewScrollbar;
	readonly scrollbarTrackStyle?: (text: string) => string;
	readonly scrollbarThumbStyle?: (text: string) => string;
	/** Fixed-width column to the right of the transcript and input dock. */
	readonly sidebar?: ChatViewportColumn;
	/** Fixed-width column to the left of the transcript and input dock. */
	readonly explorer?: ChatViewportColumn;
}

export interface ChatViewportColumn {
	readonly component: Component;
	readonly width: number;
	readonly visible: NonNullable<StackEntryOptions["visible"]>;
}

function columnEntry(column: ChatViewportColumn): StackEntry {
	return { component: column.component, basis: column.width, grow: 0, shrink: 0, visible: column.visible };
}

export interface ChatViewport {
	readonly root: Component;
	readonly transcript: ScrollView;
}

/** Shared fullscreen transcript and fixed input-dock layout. */
export function createChatViewport(options: ChatViewportOptions): ChatViewport {
	const transcript = new ScrollView(options.document, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: options.scrollbar ?? "auto",
		...(options.scrollbarTrackStyle === undefined ? {} : { scrollbarTrackStyle: options.scrollbarTrackStyle }),
		...(options.scrollbarThumbStyle === undefined ? {} : { scrollbarThumbStyle: options.scrollbarThumbStyle }),
	});
	const dock = new VStack([
		{ component: options.pendingMessages, shrink: 1, minSize: 0 },
		{ component: options.status, shrink: 1, minSize: 0 },
		...(options.widgetsAbove === undefined ? [] : [{ component: options.widgetsAbove, shrink: 1, minSize: 0 }]),
		{ component: options.editor, shrink: 1, minSize: 3 },
		...(options.widgetsBelow === undefined ? [] : [{ component: options.widgetsBelow, shrink: 1, minSize: 0 }]),
		{ component: options.footer, shrink: 1, minSize: 0 },
	]);
	const main = new VStack([
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	if (!options.sidebar && !options.explorer) return { transcript, root: main };
	return {
		transcript,
		root: new HStack(
			[
				...(options.explorer === undefined ? [] : [columnEntry(options.explorer)]),
				{ component: main, basis: 0, grow: 1, shrink: 1, minSize: 20 },
				...(options.sidebar === undefined ? [] : [columnEntry(options.sidebar)]),
			],
			{ gap: 1 },
		),
	};
}
