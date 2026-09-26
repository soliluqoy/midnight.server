import { type Component, Markdown, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SideThread, SideThreadModelRef, SideThreadTurn } from "../../../core/side-threads.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

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
		for (const line of wrapTextWithAnsi(`${theme.fg("accent", "you")}  ${turn.question}`, innerWidth)) {
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

/** Shown above the editor while it holds a side question instead of a prompt. */
export class ThreadComposerBar implements Component {
	anchorLabel = "";
	modelLabel = "";
	options = 1;

	render(width: number): string[] {
		const cycle = ` (${keyText("app.model.cycleForward")} to choose model${this.options > 1 ? `, ${keyText("app.agentMode.toggle")} to cycle` : ""})`;
		const line = theme.fg("accent", `↳ asking about: ${this.anchorLabel}`);
		const hint =
			`${theme.fg("muted", "model:")} ${theme.bold(this.modelLabel)}` +
			theme.fg(
				"dim",
				`${cycle} · ${keyText("tui.input.submit")} send · ${keyText("app.interrupt")} back to your prompt (draft kept)`,
			);
		return [truncateToWidth(line, width), truncateToWidth(hint, width)];
	}

	invalidate(): void {}
}

/** Key hints shown above the editor during thread selection. */
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
		const parts = [
			`${keyText("tui.select.up")}/${keyText("tui.select.down")} move`,
			`${keyText("app.thread.ask")} ask`,
			...(this.hasThread
				? [
						`${keyText("app.thread.toggle")} open/fold`,
						`${keyText("app.thread.sendToMain")} send to main`,
						`${keyText("app.thread.delete")} delete`,
					]
				: []),
			...(this.running ? [`${keyText("app.thread.stop")} stop`] : []),
			`${keyText("app.thread.branch")} branch before`,
			`${keyText("tui.select.cancel")} back`,
		];
		const title = `${theme.fg("accent", theme.bold("THREAD"))} ${theme.fg("text", this.selectedLabel)}`;
		return [truncateToWidth(title, width), truncateToWidth(theme.fg("dim", parts.join(" · ")), width)];
	}

	invalidate(): void {}
}
