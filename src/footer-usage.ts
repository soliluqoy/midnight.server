import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Hide the footer path, but keep the branch and session name before trimming the line.
 * If nothing is left after the path, remove the whole row.
 */
export function renderWithoutWorkingDirectory(
	render: (width: number) => string[],
	width: number,
	suffix: string,
): string[] {
	const lines = render(width);
	if (!suffix) return lines.slice(1);
	const pathLine = render(Math.max(width, 4096))[0] ?? "";
	const text = stripTerminalSequences(pathLine);
	const plainSuffix = stripTerminalSequences(suffix);
	if (!text.endsWith(plainSuffix)) return lines; // Leave it alone if the ending does not match.
	// Remove the space or bullet before the remaining text.
	const separatorWidth = plainSuffix.startsWith(" • ") ? 3 : 1;
	const start = visibleWidth(text) - visibleWidth(plainSuffix) + separatorWidth;
	return [truncateToWidth(sliceByColumn(pathLine, start, visibleWidth(text) - start), width, ""), ...lines.slice(1)];
}

/**
 * Pi 1.0.4 has no setting for this. Hide stats already shown in the sidebar.
 * Keep cache stats and extension status text in the footer.
 */
export function renderWithoutSidebarStats(render: (width: number) => string[], width: number): string[] {
	// Read a wide line so the stats are not cut off. Pi caches the totals,
	// so drawing it again does not scan the session again.
	const probe = render(Math.max(width, 4096));
	const stats = stripTerminalSequences(probe[1] ?? "");
	const match = /(?:\?|\d+(?:\.\d+)?%)\/\d+(?:\.\d+)?[kM]?(?: \(auto\))?/.exec(stats);
	if (!match) return render(width); // Keep the normal footer if the format does not match.
	const cache = /(?:[RW]\d+(?:\.\d+)?[kM]?|CH\d+(?:\.\d+)?%)(?: (?:[RW]\d+(?:\.\d+)?[kM]?|CH\d+(?:\.\d+)?%))*/.exec(
		stats.slice(0, match.index),
	);
	const cacheWidth = visibleWidth(cache?.[0] ?? "");
	const cacheText = cache ? sliceByColumn(probe[1], visibleWidth(stats.slice(0, cache.index)), cacheWidth) : "";
	const end = match.index + match[0].length;
	// Two spaces mark the start of model details. Keep any labels before them,
	// such as experimental mode, but leave out the model details.
	const modelGap = stats.indexOf("  ", end);
	const extraWidth = visibleWidth(stats.slice(end, modelGap < 0 ? undefined : modelGap));
	const extra = sliceByColumn(probe[1], visibleWidth(stats.slice(0, end)), extraWidth);
	const statsLine = truncateToWidth(cacheText + extra, width, "");
	return render(width).map((line, index) => (index === 1 ? statsLine : line));
}
