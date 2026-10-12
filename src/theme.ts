import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MIDNIGHT_THEME = "midnight";

/** Pick a default once; never replace an explicit user, project, or CLI theme. */
export function applyDefaultTheme(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || pi.getSettings().theme !== undefined || ctx.ui.theme.name !== "system") return;
	const result = ctx.ui.setTheme(MIDNIGHT_THEME);
	if (!result.success) {
		ctx.ui.notify(
			`Cannot apply Midnight's blue theme: ${result.error ?? "theme unavailable"}. Load the package directory with pi -e /path/to/midnight.server, not just src/index.ts.`,
			"warning",
		);
	}
}
