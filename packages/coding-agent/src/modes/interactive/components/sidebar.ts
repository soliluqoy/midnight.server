import {
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { APP_NAME, VERSION } from "../../../config.ts";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { GitStatusSummary } from "../../../core/git-status.ts";
import { collectSessionFileChanges, type SessionFileChange } from "../../../core/session-file-changes.ts";
import type { SessionManager } from "../../../core/session-manager.ts";
import { getSessionUsageTotals, type UsageTotals } from "../../../core/usage-totals.ts";
import { getMidnightStatus } from "../../../midnight/status.ts";
import { theme } from "../theme/theme.ts";
import { formatTokens } from "./footer.ts";
import { modeChip } from "./mode-chip.ts";

/** Sidebar width including its left border column. */
export const SIDEBAR_WIDTH = 36;
/** Below this terminal width the sidebar hides in `auto` mode so the transcript keeps enough room. */
export const SIDEBAR_MIN_TERMINAL_WIDTH = 110;
const MAX_LISTED_FILES = 12;

export interface SidebarOptions {
	session: () => AgentSession;
	footerData: ReadonlyFooterDataProvider;
	gitStatus: { getStatus(): GitStatusSummary | undefined };
	/** Terminal height, used to draw the left border down the full column. */
	getHeight: () => number;
	/** Display text for the plan/build toggle key, or undefined when unbound. */
	agentModeKey: () => string | undefined;
	/** Click on the mode chip. */
	onToggleAgentMode?: () => void;
	/** Click on the model. */
	onSelectModel?: () => void;
	/** Click on a modified file (workspace-relative path). */
	onOpenFile?: (path: string) => void;
}

/** Summarize git status as short tokens, e.g. ["↑1", "3 changed", "1 staged"]. */
export function describeGitStatus(status: GitStatusSummary | undefined): string[] {
	if (!status) return [];
	const parts: string[] = [];
	if (status.ahead) parts.push(`↑${status.ahead}`);
	if (status.behind) parts.push(`↓${status.behind}`);
	if (status.changedFiles === 0) parts.push("clean");
	else parts.push(`${status.changedFiles} changed`);
	if (status.staged) parts.push(`${status.staged} staged`);
	if (status.conflicted) parts.push(`${status.conflicted} conflicted`);
	return parts;
}

function contextBar(percent: number, width: number): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	const color = clamped > 90 ? "error" : clamped > 70 ? "warning" : "accent";
	return theme.fg(color, "█".repeat(filled)) + theme.fg("borderMuted", "░".repeat(width - filled));
}

/**
 * opencode-style session sidebar for the fullscreen TUI: session, git, context, model,
 * plan/build mode, and files changed in this session. The mode chip, the model and each
 * modified file are clickable.
 */
export class SidebarComponent implements Component {
	private readonly options: SidebarOptions;
	private sessionScan:
		| {
				sessionManager: SessionManager;
				revision: number;
				name: string | undefined;
				totals: UsageTotals;
				changes: SessionFileChange[];
		  }
		| undefined;
	/** Actions for the rows drawn in the last render, by row. */
	private clickTargets = new Map<number, () => void>();

	constructor(options: SidebarOptions) {
		this.options = options;
	}

	/**
	 * Values that walk every session entry. The sidebar renders on every frame, including each
	 * scroll step, so recompute them only when the session changes.
	 */
	private scanSession(sessionManager: SessionManager): NonNullable<SidebarComponent["sessionScan"]> {
		const revision = sessionManager.getRevision();
		const cached = this.sessionScan;
		if (cached && cached.sessionManager === sessionManager && cached.revision === revision) return cached;
		const entries = sessionManager.getEntries();
		this.sessionScan = {
			sessionManager,
			revision,
			name: sessionManager.getSessionName(),
			totals: getSessionUsageTotals(entries),
			changes: collectSessionFileChanges(entries, sessionManager.getCwd()),
		};
		return this.sessionScan;
	}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		const action = this.clickTargets.get(event.y);
		if (!action) return undefined;
		if (event.type === "click") action();
		return { handled: true };
	}

	render(width: number): string[] {
		// Left border, a space, then content with a one-column right margin.
		const contentWidth = Math.max(1, width - 3);
		const lines: string[] = [];
		const line = (text = "", onClick?: () => void) => {
			if (onClick) this.clickTargets.set(lines.length, onClick);
			lines.push(truncateToWidth(text, contentWidth, theme.fg("dim", "…")));
		};
		this.clickTargets = new Map();
		const heading = (text: string) => {
			line();
			line(theme.bold(theme.fg("muted", text.toUpperCase())));
		};

		const session = this.options.session();
		const status = getMidnightStatus();
		const model = session.state.model;

		line(`${theme.fg("accent", "☾")} ${theme.bold(theme.fg("text", APP_NAME))}${theme.fg("dim", ` v${VERSION}`)}`);
		const key = this.options.agentModeKey();
		line(
			`${modeChip(status.agentMode)}${theme.fg("dim", ` ${key ? `${key} or click` : "click"} to switch`)}`,
			this.options.onToggleAgentMode,
		);

		heading("Session");
		const scan = this.scanSession(session.sessionManager);
		const name = scan.name;
		line(name ? theme.fg("text", name) : theme.fg("dim", "untitled"));

		const branch = this.options.footerData.getGitBranch();
		if (branch) {
			heading("Git");
			line(`${theme.fg("muted", "⎇")} ${theme.fg("text", branch)}`);
			const gitParts = describeGitStatus(this.options.gitStatus.getStatus());
			if (gitParts.length > 0) line(theme.fg("muted", gitParts.join(" · ")));
		}

		heading("Context");
		const usage = session.getContextUsage();
		const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
		if (usage?.percent !== null && usage?.percent !== undefined) {
			line(
				`${contextBar(usage.percent, Math.min(20, contentWidth))} ${theme.fg("muted", `${usage.percent.toFixed(0)}%`)}`,
			);
			line(theme.fg("muted", `${formatTokens(usage.tokens ?? 0)} / ${formatTokens(contextWindow)} tokens`));
		} else {
			line(theme.fg("muted", `? / ${formatTokens(contextWindow)} tokens`));
		}
		const totals = scan.totals;
		const spend = [`↑${formatTokens(totals.input)}`, `↓${formatTokens(totals.output)}`];
		if (totals.cost > 0) spend.push(`$${totals.cost.toFixed(3)}`);
		line(theme.fg("muted", spend.join("  ")));

		heading("Model");
		if (model) {
			line(`${theme.fg("text", model.id)} ${theme.fg("dim", "▾")}`, this.options.onSelectModel);
			const detail = [model.provider];
			if (model.reasoning) detail.push(`thinking ${session.state.thinkingLevel || "off"}`);
			line(theme.fg("muted", detail.join(" · ")), this.options.onSelectModel);
		} else {
			line(theme.fg("dim", "no model ▾"), this.options.onSelectModel);
		}

		const changes = scan.changes;
		if (changes.length > 0) {
			heading(`Modified files (${changes.length})`);
			for (const change of changes.slice(0, MAX_LISTED_FILES)) {
				const counts = `${theme.fg("toolDiffAdded", `+${change.added}`)} ${theme.fg("toolDiffRemoved", `-${change.removed}`)}`;
				const countsWidth = visibleWidth(counts);
				const pathWidth = Math.max(1, contentWidth - countsWidth - 1);
				const path = truncateToWidth(change.path, pathWidth, "…");
				const onOpenFile = this.options.onOpenFile;
				line(
					`${theme.fg("text", path)}${" ".repeat(Math.max(1, contentWidth - visibleWidth(path) - countsWidth))}${counts}`,
					onOpenFile ? () => onOpenFile(change.path) : undefined,
				);
			}
			if (changes.length > MAX_LISTED_FILES) line(theme.fg("dim", `+${changes.length - MAX_LISTED_FILES} more`));
		}

		const height = Math.max(lines.length, this.options.getHeight());
		const border = theme.fg("borderMuted", "│");
		const rendered: string[] = [];
		for (let row = 0; row < height; row++) rendered.push(`${border} ${lines[row] ?? ""}`);
		return rendered;
	}
}
