import { relative } from "node:path";
import { FooterComponent, type ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { type Component, Container, HStack, isViewportTUI, type TUI } from "@earendil-works/pi-tui";
import { renderWithoutSidebarStats, renderWithoutWorkingDirectory } from "./footer-usage.ts";

export type PanelMode = "auto" | "always" | "hidden";

export function panelVisibility(
	width: number,
	sidebar: PanelMode,
	explorer: PanelMode,
): { sidebar: boolean; explorer: boolean } {
	const left = explorer !== "hidden" && width >= (explorer === "auto" ? 150 : 72);
	const right = sidebar !== "hidden" && width >= (sidebar === "auto" ? 110 : 76) && (!left || width >= 108);
	return { sidebar: right, explorer: left };
}

function isComponent(value: unknown): value is Component {
	return (
		typeof value === "object" &&
		value !== null &&
		"render" in value &&
		typeof value.render === "function" &&
		"invalidate" in value &&
		typeof value.invalidate === "function"
	);
}

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

/** Override one read. Methods still use the original object and its cached stats. */
function overrideRead<T extends object>(target: T, key: PropertyKey, read: () => unknown): T {
	return new Proxy(target, {
		get(object, property) {
			if (property === key) return read();
			const value: unknown = Reflect.get(object, property, object);
			return typeof value === "function" ? value.bind(object) : value;
		},
	});
}

/** Hide the name before Pi trims the path. Leave the shared session data alone. */
function withoutSessionName(footer: FooterComponent): FooterComponent {
	return overrideRead(footer, "session", () => {
		const session: unknown = Reflect.get(footer, "session");
		if (!isObject(session)) return session;
		const manager: unknown = Reflect.get(session, "sessionManager");
		if (!isObject(manager) || typeof Reflect.get(manager, "getSessionName") !== "function") return session;
		const view = overrideRead(manager, "getSessionName", () => () => undefined);
		return overrideRead(session, "sessionManager", () => view);
	});
}

/** Keep checks for Pi 1.0.4's private layout and footer fields in this class. */
export class SidebarLayout {
	private readonly tui: TUI;
	private readonly sidebar: Component;
	private readonly explorer: Component;
	private readonly explorerPath: () => string | undefined;
	private original: Component | undefined;
	private mounted: HStack | undefined;
	private readonly footers = new Map<
		FooterComponent,
		{
			original: ReadonlyFooterDataProvider;
			filtered: ReadonlyFooterDataProvider;
			render: Component["render"];
			filteredRender: Component["render"];
		}
	>();
	sidebarMode: PanelMode = "auto";
	explorerMode: PanelMode = "auto";
	private disposed = false;

	constructor(
		tui: TUI,
		sidebar: Component,
		explorer: Component,
		explorerPath: () => string | undefined = () => undefined,
	) {
		this.tui = tui;
		this.sidebar = sidebar;
		this.explorer = explorer;
		this.explorerPath = explorerPath;
	}

	ensure(): boolean {
		if (this.disposed || !isViewportTUI(this.tui)) return false;
		const root: unknown = Reflect.get(this.tui, "layoutRoot");
		if (root === this.mounted && this.mounted) return true;
		if (!isComponent(root)) return false;
		this.original = root;
		this.attachFooter(root);
		this.mounted = new HStack([
			{
				component: this.explorer,
				basis: 32,
				shrink: 0,
				visible: ({ width }) => panelVisibility(width, this.sidebarMode, this.explorerMode).explorer,
			},
			{ component: root, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{
				component: this.sidebar,
				basis: 36,
				shrink: 0,
				visible: ({ width }) => panelVisibility(width, this.sidebarMode, this.explorerMode).sidebar,
			},
		]);
		this.tui.setLayoutRoot(this.mounted);
		return true;
	}

	visibility(): { sidebar: boolean; explorer: boolean } {
		if (
			this.disposed ||
			!isViewportTUI(this.tui) ||
			!this.mounted ||
			Reflect.get(this.tui, "layoutRoot") !== this.mounted
		)
			return { sidebar: false, explorer: false };
		return panelVisibility(this.tui.terminal.columns, this.sidebarMode, this.explorerMode);
	}

	autoCompactEnabled(): boolean | undefined {
		for (const footer of this.footers.keys()) {
			const enabled: unknown = Reflect.get(footer, "autoCompactEnabled");
			if (typeof enabled === "boolean") return enabled;
		}
		return undefined;
	}

	private attachFooter(component: Component): void {
		if (component instanceof Container) {
			for (const child of component.children) this.attachFooter(child);
		}
		if (!(component instanceof FooterComponent) || this.footers.has(component)) return;
		// Only change what Pi's footer sees. Leave shared data and custom footers alone.
		const data: unknown = Reflect.get(component, "footerData");
		if (typeof data !== "object" || data === null) return;
		for (const key of ["getGitBranch", "getExtensionStatuses", "getAvailableProviderCount", "onBranchChange"])
			if (typeof Reflect.get(data, key) !== "function") return;
		const original = data as ReadonlyFooterDataProvider;
		const filtered: ReadonlyFooterDataProvider = {
			getGitBranch: () => (this.visibility().sidebar ? null : original.getGitBranch()),
			getExtensionStatuses: () => original.getExtensionStatuses(),
			getAvailableProviderCount: () => original.getAvailableProviderCount(),
			onBranchChange: (callback) => original.onBranchChange(callback),
		};
		const render = component.render;
		const view = withoutSessionName(component);
		const filteredRender = (width: number): string[] => {
			const visible = this.visibility();
			const draw = (size: number) =>
				visible.sidebar
					? renderWithoutSidebarStats((columns) => render.call(view, columns), size)
					: render.call(component, size);
			// Explorer may show a different folder. Compare full paths, not display text.
			// Hide the working path only if Explorer is showing that same path.
			const root = visible.explorer && this.tui.terminal.rows >= 2 ? this.explorerPath() : undefined;
			const session: unknown = Reflect.get(component, "session");
			const manager: unknown = isObject(session) ? Reflect.get(session, "sessionManager") : undefined;
			if (root && isObject(manager)) {
				const getCwd: unknown = Reflect.get(manager, "getCwd");
				const getName: unknown = Reflect.get(manager, "getSessionName");
				const cwd: unknown = typeof getCwd === "function" ? Reflect.apply(getCwd, manager, []) : undefined;
				if (typeof cwd === "string" && relative(root, cwd) === "" && typeof getName === "function") {
					const name: unknown = visible.sidebar ? undefined : Reflect.apply(getName, manager, []);
					const branch = filtered.getGitBranch();
					const suffix = `${branch ? ` (${branch})` : ""}${typeof name === "string" && name ? ` • ${name}` : ""}`;
					return renderWithoutWorkingDirectory(draw, width, suffix);
				}
			}
			return draw(width);
		};
		if (Reflect.set(component, "footerData", filtered)) {
			component.render = filteredRender;
			this.footers.set(component, { original, filtered, render, filteredRender });
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const [footer, { original, filtered, render, filteredRender }] of this.footers) {
			if (Reflect.get(footer, "footerData") === filtered) Reflect.set(footer, "footerData", original);
			if (footer.render === filteredRender) footer.render = render;
		}
		this.footers.clear();
		if (isViewportTUI(this.tui) && Reflect.get(this.tui, "layoutRoot") === this.mounted)
			this.tui.setLayoutRoot(this.original);
	}
}

export function focusedComponent(tui: TUI): Component | null {
	const getter: unknown = Reflect.get(tui, "getFocusedComponent");
	if (typeof getter !== "function") return null;
	const value: unknown = Reflect.apply(getter, tui, []);
	return isComponent(value) ? value : null;
}
