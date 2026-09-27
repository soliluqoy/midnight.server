import type { AgentMode } from "../../../midnight/status.ts";
import { theme } from "../theme/theme.ts";

/**
 * The plan/build mode as a filled chip (" BUILD " on the accent color, " PLAN " on the warning
 * color), shared by the header, sidebar and footer. Inverse video fills the label with the color
 * whatever the terminal background is.
 */
export function modeChip(mode: AgentMode): string {
	const label = mode === "plan" ? " PLAN " : " BUILD ";
	return theme.inverse(theme.bold(theme.fg(mode === "plan" ? "warning" : "accent", label)));
}

/** Visible width of a chip, for click hit-testing. */
export function modeChipWidth(mode: AgentMode): number {
	return mode === "plan" ? 6 : 7;
}
