import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

const PALETTE_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 16,
	maxPrimaryColumnWidth: 36,
};
const MAX_VISIBLE = 12;

export interface PaletteEntry {
	/** Unique id passed back to onSelect. */
	id: string;
	label: string;
	description?: string;
	/** Extra words that should match the query without being shown, e.g. the key binding. */
	keywords?: string;
}

/**
 * opencode-style command palette: a fuzzy-filtered list of actions and slash commands.
 * Typing filters, up/down moves, enter runs the selection, escape closes.
 */
export class CommandPaletteComponent extends Container implements Focusable {
	private readonly searchInput: Input;
	private readonly entries: readonly PaletteEntry[];
	private readonly allItems: SelectItem[];
	private readonly onSelect: (id: string) => void;
	private readonly onCancel: () => void;
	private selectList: SelectList;
	private readonly selectListChildIndex: number;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(entries: readonly PaletteEntry[], onSelect: (id: string) => void, onCancel: () => void) {
		super();
		this.entries = entries;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.allItems = entries.map((entry) => ({ value: entry.id, label: entry.label, description: entry.description }));

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold(theme.fg("accent", "Command palette")), 0, 0));
		this.addChild(new Spacer(1));
		this.searchInput = new Input();
		this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.selectList = this.buildSelectList(this.allItems);
		this.selectListChildIndex = this.children.length;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					`  type to filter · ${keyDisplayText("tui.select.confirm")} to run · ${keyDisplayText("tui.select.cancel")} to close`,
				),
				0,
				0,
			),
		);
		this.addChild(new DynamicBorder());
	}

	private buildSelectList(items: SelectItem[]): SelectList {
		const list = new SelectList(items, MAX_VISIBLE, getSelectListTheme(), PALETTE_LAYOUT);
		list.onSelect = (item) => this.onSelect(item.value);
		list.onCancel = () => this.onCancel();
		return list;
	}

	private applyFilter(query: string): void {
		const byId = new Map(this.entries.map((entry) => [entry.id, entry]));
		const filtered = query
			? fuzzyFilter(this.allItems, query, (item) => {
					const entry = byId.get(item.value);
					return `${item.label} ${item.description ?? ""} ${entry?.keywords ?? ""}`;
				})
			: this.allItems;
		const list = this.buildSelectList(filtered);
		this.children[this.selectListChildIndex] = list;
		this.selectList = list;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (
			kb.matches(keyData, "tui.select.up") ||
			kb.matches(keyData, "tui.select.down") ||
			kb.matches(keyData, "tui.select.confirm") ||
			kb.matches(keyData, "tui.select.cancel")
		) {
			this.selectList.handleInput(keyData);
			return;
		}
		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
