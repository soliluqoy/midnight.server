import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function truncateLeftToWidth(text: string, maxWidth: number, ellipsis = "…"): string {
	if (maxWidth <= 0) return "";
	const width = visibleWidth(text);
	if (width <= maxWidth) return text;
	const target = maxWidth - visibleWidth(ellipsis);
	if (target <= 0) return truncateToWidth(ellipsis, maxWidth, "");
	return ellipsis + sliceByColumn(text, width - target, target, true);
}

export function alignColumns(left: string, right: string, width: number): string {
	const tail = truncateToWidth(right, Math.max(0, width - 1), "…");
	const head = truncateToWidth(left, Math.max(0, width - visibleWidth(tail) - 1), "…");
	return head + " ".repeat(Math.max(0, width - visibleWidth(head) - visibleWidth(tail))) + tail;
}
