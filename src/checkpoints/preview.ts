import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import type { HeadMove, RestorePlan } from "./core.ts";

export const branchName = (ref: string): string => ref.replace(/^refs\/heads\//, "");

/** One sentence on what a restore does to Git HEAD, shared by the preview and the confirmation. */
export function headSummary(move: HeadMove | undefined): string {
	if (!move) return "Git HEAD stays unchanged.";
	const leaving = move.leaving
		? `${move.leaving} commit(s) leave the branch; the old tip stays in the reflog and the recovery checkpoint.`
		: "No commit leaves the branch.";
	return `${branchName(move.ref)} moves from ${move.from.slice(0, 7)} to ${move.to.slice(0, 7)}. ${leaving}`;
}

export async function reviewRestore(ctx: ExtensionCommandContext, plan: RestorePlan): Promise<boolean> {
	const clean = (path: string) => stripTerminalSequences(path).replace(/[\r\n\t]/g, " ");
	const deletions = plan.changes.filter((change) => change.deletion).length;
	const commits = plan.head?.commits ?? [];
	const contents = [
		"READ-ONLY restore preview — Enter: continue to confirmation · Esc: cancel · arrows/PageUp/PageDown: scroll",
		`${plan.changes.length} changed paths: ${plan.changes.length - deletions} restored, ${deletions} deleted (they exist only after this checkpoint). ${headSummary(plan.head)} A recovery backup is mandatory.`,
		...(commits.length
			? [
					"",
					"Commits leaving the branch:",
					...commits.map(clean),
					...(plan.head && plan.head.leaving > commits.length
						? [`… and ${plan.head.leaving - commits.length} more`]
						: []),
				]
			: []),
		"",
		...plan.changes.map(
			(change) =>
				`${change.deletion ? "DELETE" : "RESTORE"} ${clean(change.path)} — ${[change.worktree ? "worktree" : "", change.index ? "staged index" : ""].filter(Boolean).join(" + ")}`,
		),
		...(plan.kept.length
			? [
					"",
					"Changed by those commits but not captured in the snapshot; kept as uncommitted changes:",
					...plan.kept.map(clean),
				]
			: []),
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
