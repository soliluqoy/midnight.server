import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { APP_NAME, VERSION } from "../../../config.ts";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { GitStatusSummary } from "../../../core/git-status.ts";
import { collectSessionFileChanges } from "../../../core/session-file-changes.ts";
import { getSessionUsageTotals } from "../../../core/usage-totals.ts";
import { getMidnightStatus, type MidnightStatus } from "../../../midnight/status.ts";
import { theme } from "../theme/theme.ts";
import { formatTokens } from "./footer.ts";

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
}

export function describeSessionMode(mode: MidnightStatus["mode"]): string | undefined {
	if (mode === "local") return "local only";
	if (mode === "fallback") return "local (no provider)";
	return mode;
}

export function describeEngine(engine: MidnightStatus["engine"]): string {
	if (engine === "off") return "idle";
	if (engine === "starting") return "starting…";
	return engine;
}

export function describeDrift(status: Readonly<MidnightStatus>): string {
	const drift = status.drift;
	if (!drift) return "off";
	if (drift.checking) return "checking…";
	return drift.lastVerdict ? drift.lastVerdict.replace("_", " ") : "no check yet";
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
 * local-model state, plan/build mode, and files changed in this session.
 */
export class SidebarComponent implements Component {
	private readonly options: SidebarOptions;

	constructor(options: SidebarOptions) {
		this.options = options;
	}

	invalidate(): void {}

	render(width: number): string[] {
		// Left border, a space, then content with a one-column right margin.
		const contentWidth = Math.max(1, width - 3);
		const lines: string[] = [];
		const line = (text = "") => lines.push(truncateToWidth(text, contentWidth, theme.fg("dim", "…")));
		const heading = (text: string) => {
			line();
			line(theme.bold(theme.fg("muted", text.toUpperCase())));
		};

		const session = this.options.session();
		const status = getMidnightStatus();
		const model = session.state.model;

		line(theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${VERSION}`));
		const mode = describeSessionMode(status.mode);
		const plan = status.agentMode === "plan";
		const badge = plan ? theme.bold(theme.fg("warning", "PLAN")) : theme.bold(theme.fg("success", "BUILD"));
		const key = this.options.agentModeKey();
		line(`${badge}${key ? theme.fg("dim", ` ${key} to switch`) : ""}`);
		if (mode) line(theme.fg("dim", mode));

		heading("Session");
		const name = session.sessionManager.getSessionName();
		line(name ? theme.fg("text", name) : theme.fg("dim", "untitled"));

		const branch = this.options.footerData.getGitBranch();
		if (branch) {
			heading("Git");
			line(`${theme.fg("accent", "⎇")} ${theme.fg("text", branch)}`);
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
		const totals = getSessionUsageTotals(session.sessionManager.getEntries());
		const spend = [`↑${formatTokens(totals.input)}`, `↓${formatTokens(totals.output)}`];
		if (totals.cost > 0) spend.push(`$${totals.cost.toFixed(3)}`);
		line(theme.fg("muted", spend.join("  ")));

		heading("Model");
		if (model) {
			line(theme.fg("text", model.id));
			const detail = [model.provider];
			if (model.reasoning) detail.push(`thinking ${session.state.thinkingLevel || "off"}`);
			line(theme.fg("muted", detail.join(" · ")));
		} else {
			line(theme.fg("dim", "no model"));
		}

		heading("Midnight");
		line(`${theme.fg("muted", "engine")} ${theme.fg("text", describeEngine(status.engine))}`);
		if (status.engine === "starting" && status.activity) line(theme.fg("dim", status.activity));
		const driftColor = status.drift?.lastVerdict && status.drift.lastVerdict !== "on_track" ? "warning" : "text";
		line(`${theme.fg("muted", "drift")}  ${theme.fg(driftColor, describeDrift(status))}`);

		const changes = collectSessionFileChanges(session.sessionManager.getEntries(), session.sessionManager.getCwd());
		if (changes.length > 0) {
			heading(`Modified files (${changes.length})`);
			for (const change of changes.slice(0, MAX_LISTED_FILES)) {
				const counts = `${theme.fg("toolDiffAdded", `+${change.added}`)} ${theme.fg("toolDiffRemoved", `-${change.removed}`)}`;
				const countsWidth = visibleWidth(counts);
				const pathWidth = Math.max(1, contentWidth - countsWidth - 1);
				const path = truncateToWidth(change.path, pathWidth, "…");
				line(
					`${theme.fg("text", path)}${" ".repeat(Math.max(1, contentWidth - visibleWidth(path) - countsWidth))}${counts}`,
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
