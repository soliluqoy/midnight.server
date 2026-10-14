import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	stripTerminalSequences,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { GitStatusSummary } from "./git-status.ts";
import { alignColumns, truncateLeftToWidth } from "./presentation.ts";
import { SessionAnalysis, sessionEntryCount } from "./session-analysis.ts";
import type { PendingFile, PendingSnapshot } from "./session-pending-files.ts";

export class Sidebar implements Component {
	private readonly context: () => ExtensionContext;
	private readonly pi: ExtensionAPI;
	private readonly height: () => number;
	private readonly preview: (change: PendingFile) => void;
	private readonly selectModel: () => void;
	private readonly getAutoCompact: () => boolean | undefined;
	private readonly analysis = new SessionAnalysis();
	private readonly requestRender: () => void;
	private refreshQueued = false;
	private disposed = false;
	private rows: PendingFile[] = [];
	updating = false;
	get candidates() {
		return this.analysis.changes;
	}

	publish(snapshot: PendingSnapshot): void {
		this.rows = snapshot.rows;
		this.changedPaths = snapshot.changedPaths;
		this.updating = false;
		this.invalidate();
	}
	changedPaths: ReadonlySet<string> = new Set();
	branch = "";
	git: GitStatusSummary | undefined;
	private contextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
	private revision:
		| {
				manager: ExtensionContext["sessionManager"];
				sessionId: string;
				count: number | undefined;
				leaf: string | null;
				model: ExtensionContext["model"];
		  }
		| undefined;
	private autoCompact: boolean | undefined;
	private cache: { width: number; height: number; lines: string[] } | undefined;
	private clicks = new Map<number, () => void>();

	constructor(
		context: () => ExtensionContext,
		pi: ExtensionAPI,
		height: () => number,
		preview: (change: PendingFile) => void,
		selectModel: () => void,
		getAutoCompact: () => boolean | undefined = () => undefined,
		requestRender: () => void = () => {},
	) {
		this.context = context;
		this.pi = pi;
		this.height = height;
		this.preview = preview;
		this.selectModel = selectModel;
		this.getAutoCompact = getAutoCompact;
		this.requestRender = requestRender;
	}

	refresh(scan = true): void {
		if (this.disposed) return;
		const ctx = this.context();
		if (scan || this.needsRefresh(ctx)) {
			this.contextUsage = ctx.getContextUsage();
			this.analysis.update(ctx.sessionManager, ctx.cwd);
			this.revision = {
				manager: ctx.sessionManager,
				sessionId: ctx.sessionManager.getSessionId(),
				count: sessionEntryCount(ctx.sessionManager),
				leaf: ctx.sessionManager.getLeafId(),
				model: ctx.model,
			};
		}
		this.invalidate();
	}

	private needsRefresh(ctx: ExtensionContext): boolean {
		return (
			this.revision?.manager !== ctx.sessionManager ||
			this.revision.sessionId !== ctx.sessionManager.getSessionId() ||
			this.revision.count !== sessionEntryCount(ctx.sessionManager) ||
			this.revision.leaf !== ctx.sessionManager.getLeafId() ||
			this.revision.model !== ctx.model
		);
	}

	dispose(): void {
		this.disposed = true;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return;
		const action = this.clicks.get(event.y);
		if (!action) return;
		if (event.type === "click") action();
		return { handled: true };
	}

	render(width: number): string[] {
		const ctx = this.context();
		// message_end happens before saving. Check for saves here, then update totals outside render.
		if (!this.disposed && this.needsRefresh(ctx) && !this.refreshQueued) {
			this.refreshQueued = true;
			queueMicrotask(() => {
				this.refreshQueued = false;
				if (this.disposed) return;
				this.refresh();
				this.requestRender();
			});
		}
		const autoCompact = this.getAutoCompact();
		if (autoCompact !== this.autoCompact) {
			this.autoCompact = autoCompact;
			this.invalidate();
		}
		const height = this.height();
		if (this.cache?.width === width && this.cache.height === height) return this.cache.lines;
		const theme = ctx.ui.theme;
		const contentWidth = Math.max(1, width - 3);
		const lines: string[] = [];
		this.clicks.clear();
		const line = (text = "", action?: () => void) => {
			if (action) this.clicks.set(lines.length, action);
			lines.push(truncateToWidth(text, contentWidth, "…"));
		};
		const pair = (left: string, right: string, action?: () => void) =>
			line(alignColumns(left, right, contentWidth), action);
		const heading = (text: string, value = "") => {
			line();
			const label = theme.bold(theme.fg("muted", text));
			if (value) pair(label, value);
			else line(label);
		};
		const tokens = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value));
		line(theme.bold(theme.fg("accent", "MIDNIGHT")) + theme.fg("dim", " / SESSION"));
		const title =
			stripTerminalSequences(ctx.sessionManager.getSessionName() || "")
				.replace(/\p{Cc}/gu, " ")
				.replace(/\s+/g, " ")
				.trim() || "untitled";
		const titleLines = wrapTextWithAnsi(title, contentWidth);
		for (const [index, text] of titleLines.slice(0, 3).entries()) {
			line(
				theme.fg(
					"text",
					index === 2 && titleLines.length > 3 ? `${truncateToWidth(text, contentWidth - 1, "").trimEnd()}…` : text,
				),
			);
		}
		if (this.branch) {
			heading("GIT");
			line(theme.fg("text", stripTerminalSequences(this.branch).replace(/\p{Cc}/gu, " ")));
			if (this.git) {
				const status = this.git.changedFiles ? `${this.git.changedFiles} changed` : "clean";
				const staged = this.git.staged ? ` · ${this.git.staged} staged` : "";
				line(theme.fg("muted", status + staged));
				// Conflicts get their own row so a long status can never hide them.
				if (this.git.conflicted) line(theme.fg("error", `${this.git.conflicted} conflicted`));
				if (this.git.ahead || this.git.behind)
					pair(theme.fg("dim", "sync"), theme.fg("muted", `↑${this.git.ahead ?? 0} ↓${this.git.behind ?? 0}`));
			}
		}
		const usage = this.contextUsage;
		const percent = usage?.percent != null && Number.isFinite(usage.percent) ? usage.percent : undefined;
		const usageColor =
			percent !== undefined && percent > 90 ? "error" : percent !== undefined && percent > 70 ? "warning" : "accent";
		heading(
			this.autoCompact ? "CONTEXT (auto)" : "CONTEXT",
			percent === undefined ? "" : theme.fg(usageColor, `${percent.toFixed(1)}%`),
		);
		if (percent !== undefined) {
			const barWidth = contentWidth;
			const filled = Math.round((Math.max(0, Math.min(100, percent)) * barWidth) / 100);
			line(theme.fg(usageColor, "━".repeat(filled)) + theme.fg("borderMuted", "─".repeat(barWidth - filled)));
		}
		line(
			theme.fg(
				"muted",
				`${usage?.tokens == null ? "?" : tokens(usage.tokens)} / ${tokens(usage?.contextWindow ?? ctx.model?.contextWindow ?? 0)} tokens`,
			),
		);
		pair(
			theme.fg("dim", "in / out"),
			theme.fg("muted", `↑${tokens(this.analysis.totals.input)} ↓${tokens(this.analysis.totals.output)}`),
		);
		const subscription =
			ctx.model && (ctx.model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(ctx.model));
		pair(
			theme.fg("dim", "cost"),
			theme.fg("text", `$${this.analysis.totals.cost.toFixed(3)}${subscription ? " (sub)" : ""}`),
		);
		heading("MODEL");
		line(theme.fg("text", stripTerminalSequences(ctx.model?.id ?? "no model")), this.selectModel);
		line(
			theme.fg("muted", [ctx.model?.provider, this.pi.getThinkingLevel()].filter(Boolean).join(" · ")),
			this.selectModel,
		);
		const pending = this.rows.filter((row) => row.state === "pending");
		const recorded = this.rows.filter((row) => row.state === "unavailable" || row.state === "checking");
		if (pending.length || this.updating) {
			heading(
				pending.length ? `SESSION FILES (${pending.length})` : "SESSION FILES",
				this.updating ? theme.fg("warning", "updating") : "",
			);
			if (this.updating) line(theme.fg("warning", "Previous snapshot may be stale"));
			if (pending.length) line(theme.fg("dim", "staged + unstaged / untracked"));
			const visible = pending.slice(0, 12);
			const addedWidth = Math.max(1, ...visible.map((row) => String(row.added ?? 0).length));
			const removedWidth = Math.max(1, ...visible.map((row) => String(row.removed ?? 0).length));
			for (const change of visible) {
				const counts =
					change.added === undefined || change.removed === undefined
						? theme.fg(
								change.status?.kind === "u" ? "error" : "muted",
								change.status?.kind === "u" ? "conflict" : "status only",
							)
						: `${theme.fg("toolDiffAdded", `+${change.added}`.padStart(addedWidth + 1))} ${theme.fg("toolDiffRemoved", `−${change.removed}`.padStart(removedWidth + 1))}`;
				const path = truncateLeftToWidth(
					stripTerminalSequences(change.path).replace(/\p{Cc}/gu, " "),
					Math.max(0, contentWidth - visibleWidth(counts) - 1),
				);
				pair(theme.fg("text", path), counts, () => this.preview(change));
			}
			if (pending.length > 12) line(theme.fg("muted", `+${pending.length - 12} more`));
		}
		if (recorded.length) {
			heading(`RECORDED FILES (${recorded.length})`);
			line(theme.fg("warning", "history only · status unavailable"));
			const limit = Math.max(0, 12 - pending.length);
			for (const row of recorded.slice(0, limit))
				line(
					theme.fg(
						"muted",
						truncateLeftToWidth(stripTerminalSequences(row.path).replace(/\p{Cc}/gu, " "), contentWidth),
					),
					() => this.preview(row),
				);
			if (recorded.length > limit) line(theme.fg("muted", `+${recorded.length - limit} more`));
		}
		const rendered = Array.from({ length: height }, (_, row) =>
			truncateToWidth(`${theme.fg("borderMuted", "│")} ${lines[row] ?? ""}`, width, ""),
		);
		this.cache = { width, height, lines: rendered };
		return rendered;
	}
}
