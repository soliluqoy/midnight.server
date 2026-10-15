import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import type { RestorePlan } from "./core.ts";

export async function reviewRestore(ctx: ExtensionCommandContext, plan: RestorePlan): Promise<boolean> {
	const clean = (path: string) => stripTerminalSequences(path).replace(/[\r\n\t]/g, " ");
	const contents = [
		"READ-ONLY restore preview — Enter: continue to confirmation · Esc: cancel · arrows/PageUp/PageDown: scroll",
		`${plan.changes.length} changed paths. Git HEAD remains unchanged. A recovery backup is mandatory.`,
		"",
		...plan.changes.map(
			(change) =>
				`${change.deletion ? "DELETE" : "RESTORE"} ${clean(change.path)} — ${[change.worktree ? "worktree" : "", change.index ? "staged index" : ""].filter(Boolean).join(" + ")}`,
		),
		"",
		"Excluded from snapshot:",
		...plan.target.excluded.map((entry) => `${clean(entry.path)} — ${clean(entry.reason)}`),
	].join("\n");
	return ctx.ui.custom<boolean>((tui, _theme, _keys, done) => {
		const text = new Text(contents, 0, 0);
		let offset = 0;
		let total = 0;
		let page = 20;
		return {
			render(width: number) {
				const lines = text.render(width);
				page = Math.max(1, tui.terminal.rows - 4);
				total = lines.length;
				offset = Math.min(offset, Math.max(0, total - page));
				return lines.slice(offset, offset + page);
			},
			invalidate() {
				text.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, "escape")) {
					done(false);
					return;
				}
				if (matchesKey(data, "enter")) {
					done(true);
					return;
				}
				if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
				if (matchesKey(data, "down")) offset = Math.min(Math.max(0, total - page), offset + 1);
				if (matchesKey(data, "pageUp")) offset = Math.max(0, offset - page);
				if (matchesKey(data, "pageDown")) offset = Math.min(Math.max(0, total - page), offset + page);
				if (matchesKey(data, "home")) offset = 0;
				if (matchesKey(data, "end")) offset = Math.max(0, total - page);
				tui.requestRender();
			},
		};
	});
}
