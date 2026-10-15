import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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
	if (!text.endsWith(plainSuffix)) return lines;
	const separatorWidth = plainSuffix.startsWith(" • ") ? 3 : 1;
	const start = visibleWidth(text) - visibleWidth(plainSuffix) + separatorWidth;
	return [truncateToWidth(sliceByColumn(pathLine, start, visibleWidth(text) - start), width, ""), ...lines.slice(1)];
}

export function renderWithoutSidebarStats(render: (width: number) => string[], width: number): string[] {
	const probe = render(Math.max(width, 4096));
	const stats = stripTerminalSequences(probe[1] ?? "");
	const match = /(?:\?|\d+(?:\.\d+)?%)\/\d+(?:\.\d+)?[kM]?(?: \(auto\))?/.exec(stats);
	if (!match) return render(width);
	const cache = /(?:[RW]\d+(?:\.\d+)?[kM]?|CH\d+(?:\.\d+)?%)(?: (?:[RW]\d+(?:\.\d+)?[kM]?|CH\d+(?:\.\d+)?%))*/.exec(
		stats.slice(0, match.index),
	);
	const cacheWidth = visibleWidth(cache?.[0] ?? "");
	const cacheText = cache ? sliceByColumn(probe[1], visibleWidth(stats.slice(0, cache.index)), cacheWidth) : "";
	const end = match.index + match[0].length;
	const modelGap = stats.indexOf("  ", end);
	const extraWidth = visibleWidth(stats.slice(end, modelGap < 0 ? undefined : modelGap));
	const extra = sliceByColumn(probe[1], visibleWidth(stats.slice(0, end)), extraWidth);
	const statsLine = truncateToWidth(cacheText + extra, width, "");
	return render(width).map((line, index) => (index === 1 ? statsLine : line));
}
