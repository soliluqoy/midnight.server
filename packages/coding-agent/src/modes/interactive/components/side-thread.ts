import { type Component, Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SideThread, SideThreadModelRef, SideThreadTurn } from "../../../core/side-threads.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { firstKeyText } from "./keybinding-hints.ts";

const INDENT = "  ";
const BAR = "│ ";

export function modelRefLabel(ref: SideThreadModelRef): string {
	if (ref.kind === "local") return "local";
	return ref.id;
}

function firstLine(text: string, max = 60): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function turnWord(count: number): string {
	return count === 1 ? "1 side question" : `${count} side questions`;
}

function elapsed(turn: SideThreadTurn): string {
	return `${Math.max(0, Math.round(((turn.finishedAt ?? Date.now()) - turn.startedAt) / 1000))}s`;
}

/** One line for a folded thread: count, models, and the latest exchange. */
export function renderFoldedThread(thread: SideThread, width: number): string[] {
	const models = [...new Set(thread.turns.map((turn) => modelRefLabel(turn.model)))].join(", ");
	const last = thread.turns[thread.turns.length - 1];
	let summary = "";
	if (last?.status === "running") summary = theme.fg("warning", ` answering… ${elapsed(last)}`);
	else if (last?.status === "error") summary = theme.fg("error", ` ${firstLine(last.error ?? "failed", 50)}`);
	else if (last?.status === "aborted") summary = theme.fg("muted", " stopped");
	else if (last?.origin === "drift") summary = theme.fg("warning", ` ${firstLine(last.answer, 80)}`);
	else if (last) summary = theme.fg("muted", ` "${firstLine(last.question, 30)}" → ${firstLine(last.answer, 50)}`);
	const sent = thread.sentTurns > 0 ? theme.fg("dim", " · sent to main") : "";
	const line = `${INDENT}${theme.fg("accent", `▸ ${turnWord(thread.turns.length)}`)}${theme.fg("dim", " · ")}${theme.fg("accent", models)}${summary}${sent}`;
	return [truncateToWidth(line, width)];
}

/**
 * An open thread: a header, then each question and answer behind a bar. Answers are
 * Markdown so code blocks and lists render like the main transcript.
 */
export function renderOpenThread(thread: SideThread, width: number): string[] {
	const models = [...new Set(thread.turns.map((turn) => modelRefLabel(turn.model)))].join(", ");
	const lines = [
		truncateToWidth(
			`${INDENT}${theme.fg("accent", "▾ thread")}${theme.fg("dim", " · ")}${theme.fg("accent", models)}${theme.fg("muted", `  ${turnWord(thread.turns.length)}`)}`,
			width,
		),
	];
	const bar = `${INDENT}${theme.fg("borderAccent", BAR)}`;
	const innerWidth = Math.max(10, width - INDENT.length - BAR.length);
	const markdownTheme = getMarkdownTheme();
	for (const [index, turn] of thread.turns.entries()) {
		if (index > 0) lines.push(bar);
		const asker = turn.origin === "drift" ? theme.fg("warning", "drift watch") : theme.fg("accent", "you");
		for (const line of wrapTextWithAnsi(`${asker}  ${turn.question}`, innerWidth)) {
			lines.push(bar + line);
		}
		const who = theme.fg("accent", modelRefLabel(turn.model));
		if (turn.answer.trim()) {
			lines.push(bar + who);
			for (const line of new Markdown(turn.answer, 0, 0, markdownTheme).render(innerWidth)) lines.push(bar + line);
		}
		if (turn.status === "running") {
			lines.push(bar + (turn.answer.trim() ? "" : `${who}  `) + theme.fg("warning", `answering… ${elapsed(turn)}`));
		} else if (turn.status === "error") {
			for (const line of wrapTextWithAnsi(
				theme.fg("error", `error: ${turn.error ?? "request failed"}`),
				innerWidth,
			)) {
				lines.push(bar + line);
			}
		} else if (turn.status === "aborted") {
			lines.push(bar + theme.fg("muted", "stopped"));
		}
	}
	if (thread.sentTurns > 0) {
		const pending = thread.turns.length - thread.sentTurns;
		lines.push(
			bar +
				theme.fg("dim", pending > 0 ? `sent to main (${pending} newer not sent)` : "sent to main agent's context"),
		);
	}
	return lines.map((line) => truncateToWidth(line, width));
}

/** Up/down as one compact hint, e.g. `↑↓`. */
function arrowsText(): string {
	const up = firstKeyText("tui.select.up");
	const down = firstKeyText("tui.select.down");
	return up === "up" && down === "down" ? "↑↓" : `${up}/${down}`;
}

/**
 * Room for the item label in a bar: whatever `kept` (the text that must stay visible) leaves,
 * less the "..." that truncation adds when more hints follow, between 12 and 28 columns. The
 * hints matter more than the tail of the label.
 */
function labelRoom(width: number, kept: string): number {
	return Math.max(12, Math.min(28, width - visibleWidth(kept) - 3));
}

/**
 * One line above the editor while it holds a side question instead of a prompt. When the line
 * is too narrow for every hint, whole hints are dropped from the least important (`rank`) up,
 * and the item label takes what is left. Escape (back to the prompt) is left out as the one
 * key everyone tries first.
 */
export class ThreadComposerBar implements Component {
	anchorLabel = "";
	modelLabel = "";
	options = 1;

	render(width: number): string[] {
		const cycleKeys = [firstKeyText("app.agentMode.toggle"), firstKeyText("app.thinking.cycle")].filter(Boolean);
		const searchKey = firstKeyText("app.model.select");
		const hints = [
			{ text: `${arrowsText()} item`, rank: 1 },
			...(this.options > 1 && cycleKeys.length > 0 ? [{ text: `${cycleKeys.join("/")} model`, rank: 0 }] : []),
			...(searchKey ? [{ text: `${searchKey} search`, rank: 3 }] : []),
			{ text: `${firstKeyText("app.thread.select")} threads`, rank: 2 },
		];
		const head = `↳  · ${this.modelLabel}`;
		let used = visibleWidth(head) + 12;
		const kept = new Set<(typeof hints)[number]>();
		for (const hint of [...hints].sort((a, b) => a.rank - b.rank)) {
			const cost = visibleWidth(hint.text) + 3;
			if (used + cost > width) break;
			kept.add(hint);
			used += cost;
		}
		const shown = hints.filter((hint) => kept.has(hint)).map((hint) => ` · ${hint.text}`);
		const labelWidth = Math.max(12, Math.min(28, width - visibleWidth(head) - visibleWidth(shown.join(""))));
		const line =
			theme.fg("accent", `↳ ${firstLine(this.anchorLabel, labelWidth)}`) +
			theme.fg("dim", " · ") +
			theme.bold(this.modelLabel) +
			theme.fg("dim", shown.join(""));
		return [truncateToWidth(line, width)];
	}

	invalidate(): void {}
}

/** One line of key hints above the editor while managing the selected item's thread. */
export class ThreadSelectionBar implements Component {
	selectedLabel = "";
	hasThread = false;
	running = false;
	/** Keys while selecting; the bar holds focus so the editor keeps the main draft untouched. */
	onInput: ((data: string) => void) | undefined;

	handleInput(data: string): void {
		this.onInput?.(data);
	}

	render(width: number): string[] {
		const hints = [
			`${firstKeyText("app.thread.ask")} ask`,
			...(this.hasThread
				? [`${firstKeyText("app.thread.sendToMain")} send`, `${firstKeyText("app.thread.branch")} branch`]
				: [`${firstKeyText("app.thread.branch")} branch`]),
			...(this.running ? [`${firstKeyText("app.thread.stop")} stop`] : []),
			...(this.hasThread
				? [`${firstKeyText("app.thread.toggle")} fold`, `${firstKeyText("app.thread.delete")} delete`]
				: []),
			arrowsText(),
			`${firstKeyText("tui.select.cancel")} back`,
		];
		// Keep at least ask, send and branch (the first three hints) visible.
		const kept = `THREAD  · ${hints.slice(0, 3).join(" · ")}`;
		const line =
			theme.fg("accent", theme.bold("THREAD ")) +
			theme.fg("text", firstLine(this.selectedLabel, labelRoom(width, kept))) +
			theme.fg("dim", ` · ${hints.join(" · ")}`);
		return [truncateToWidth(line, width)];
	}

	invalidate(): void {}
}
