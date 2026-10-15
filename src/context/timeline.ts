import { defined } from "./defined.ts";
import type { LiveContextState, SessionEntryLike } from "./state.ts";
import { isLiveContextState } from "./state.ts";

export interface TimelinePoint {
	request: number;
	at?: string;
	tokens: number;
	revision: number;
}

export interface TimelineMarker {
	kind: "applied" | "rejected" | "reset";
	revision: number;
	at?: string;
	afterPoint: number;
	beforeTokens?: number;
	afterTokens?: number;
	message: string;
}

export interface ContextTimeline {
	points: TimelinePoint[];
	markers: TimelineMarker[];
	peakTokens: number;
	turnStarts?: number[];
}

interface MessageEntryLike extends SessionEntryLike {
	message?: {
		role?: string;
		stopReason?: string;
		timestamp?: number | string;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			totalTokens?: number;
		};
	};
}

function usageTokens(usage: NonNullable<MessageEntryLike["message"]>["usage"]): number {
	if (!usage) return 0;
	if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) return usage.totalTokens;
	return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

function isoTime(value: number | string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

export function buildContextTimeline(entries: readonly SessionEntryLike[]): ContextTimeline {
	const points: TimelinePoint[] = [];
	const markers: TimelineMarker[] = [];
	const turnStarts: number[] = [];
	let pendingTurn = false;
	let revision = 0;
	let lastOutcomeAt: string | undefined;
	for (const entry of entries) {
		if (entry.type === "message") {
			const message = (entry as MessageEntryLike).message;
			if (message?.role === "user") pendingTurn = true;
			if (!message || message.role !== "assistant") continue;
			if (message.stopReason === "aborted" || message.stopReason === "error") continue;
			const tokens = usageTokens(message.usage);
			if (tokens <= 0) continue;
			points.push({ request: points.length + 1, at: isoTime(message.timestamp), tokens, revision });
			if (pendingTurn) turnStarts.push(points.length - 1);
			pendingTurn = false;
			continue;
		}
		if (entry.type === "custom" && entry.customType === "live-context-state" && isLiveContextState(entry.data)) {
			const state: LiveContextState = entry.data;
			revision = state.revision;
			const outcome = state.lastOutcome;
			if (!outcome || outcome.at === lastOutcomeAt) continue;
			lastOutcomeAt = outcome.at;
			const tokensUnit = outcome.estimateUnit === "tokens";
			markers.push({
				kind: outcome.kind,
				revision: state.revision,
				at: outcome.at,
				afterPoint: points.length - 1,
				beforeTokens: tokensUnit ? outcome.beforeEstimate : undefined,
				afterTokens: tokensUnit ? outcome.afterEstimate : undefined,
				message: outcome.message,
			});
		}
	}
	return { points, markers, peakTokens: points.reduce((peak, point) => Math.max(peak, point.tokens), 0), turnStarts };
}

export function formatTokenCount(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

export type TimelineZoom = "requests" | "fit" | "turns";
export const TIMELINE_ZOOMS: readonly TimelineZoom[] = ["fit", "requests", "turns"];

export interface TimelineChartOptions {
	width: number;
	height: number;
	zoom?: TimelineZoom;
	budget?: number;
	selectedMarker?: number;
	selectedPoint?: number;
	focusPoint?: number;
	style?: {
		bar?: (text: string) => string;
		editBar?: (text: string) => string;
		marker?: (text: string) => string;
		budget?: (text: string) => string;
		axis?: (text: string) => string;
		selected?: (text: string) => string;
		selectedMarker?: (text: string) => string;
		landmark?: (text: string) => string;
	};
}

export function timelineWindow(
	pointCount: number,
	columns: number,
	focus: number | undefined,
): { start: number; end: number } {
	const width = Math.max(1, Math.min(columns, pointCount));
	if (pointCount <= width) return { start: 0, end: pointCount };
	let start = pointCount - width;
	if (focus !== undefined && focus >= 0 && focus < pointCount) {
		start = Math.max(0, Math.min(pointCount - width, focus - Math.floor(width / 2)));
	}
	return { start, end: start + width };
}

export interface TimelineBucket {
	first: number;
	last: number;
	tokens: number;
	finalTokens: number;
	turns: number;
	edits: number[];
}

export interface TimelineLayout {
	zoom: TimelineZoom;
	buckets: TimelineBucket[];
	columnWidth: number;
	gap: number;
	requestsPerColumn: number;
	turnsPerColumn: number;
}

const CHART_LABEL_WIDTH = 7;

function plotWidthFor(width: number): number {
	return Math.max(8, width - CHART_LABEL_WIDTH - 1);
}

function columnGeometry(bucketCount: number, plotWidth: number): { columnWidth: number; gap: number; columns: number } {
	const columnWidth = Math.max(1, Math.min(3, Math.floor(plotWidth / Math.max(1, bucketCount)) - 1));
	const gap = bucketCount * (columnWidth + 1) <= plotWidth && columnWidth > 1 ? 1 : 0;
	return { columnWidth, gap, columns: Math.max(1, Math.floor(plotWidth / (columnWidth + gap))) };
}

function turnGroupStarts(timeline: ContextTimeline): number[] {
	const starts = new Set(timeline.turnStarts ?? []);
	starts.add(0);
	return [...starts].filter((index) => index >= 0 && index < timeline.points.length).sort((a, b) => a - b);
}

function bucketFromRange(
	timeline: ContextTimeline,
	first: number,
	last: number,
	turnStarts: ReadonlySet<number>,
): TimelineBucket {
	let tokens = 0;
	let turns = 0;
	for (let index = first; index <= last; index++) {
		tokens = Math.max(tokens, timeline.points[index]?.tokens ?? 0);
		if (turnStarts.has(index)) turns++;
	}
	return { first, last, tokens, finalTokens: timeline.points[last]?.tokens ?? 0, turns, edits: [] };
}

export function layoutTimeline(
	timeline: ContextTimeline,
	options: Pick<TimelineChartOptions, "width" | "zoom" | "focusPoint">,
): TimelineLayout {
	const zoom = options.zoom ?? "requests";
	const count = timeline.points.length;
	const plotWidth = plotWidthFor(options.width);
	const turnStarts = new Set(timeline.turnStarts ?? []);
	const ranges: Array<[number, number]> = [];
	let requestsPerColumn = 1;
	let turnsPerColumn = 1;
	if (zoom === "requests") {
		const { columns } = columnGeometry(count, plotWidth);
		const window = timelineWindow(count, columns, options.focusPoint);
		for (let index = window.start; index < window.end; index++) ranges.push([index, index]);
	} else if (zoom === "fit") {
		requestsPerColumn = Math.max(1, Math.ceil(count / plotWidth));
		for (let first = 0; first < count; first += requestsPerColumn) {
			ranges.push([first, Math.min(count, first + requestsPerColumn) - 1]);
		}
	} else {
		const starts = turnGroupStarts(timeline);
		turnsPerColumn = Math.max(1, Math.ceil(starts.length / plotWidth));
		for (let group = 0; group < starts.length; group += turnsPerColumn) {
			const next = starts[group + turnsPerColumn];
			ranges.push([defined(starts[group]), (next ?? count) - 1]);
		}
		requestsPerColumn = ranges.reduce((most, [first, last]) => Math.max(most, last - first + 1), 1);
	}
	const buckets = ranges.map(([first, last]) => bucketFromRange(timeline, first, last, turnStarts));
	timeline.markers.forEach((marker, markerIndex) => {
		if (marker.kind !== "applied") return;
		bucketContaining(buckets, marker.afterPoint)?.edits.push(markerIndex);
	});
	const { columnWidth, gap } = columnGeometry(buckets.length, plotWidth);
	return { zoom, buckets, columnWidth, gap, requestsPerColumn, turnsPerColumn };
}

function bucketContaining(buckets: readonly TimelineBucket[], point: number | undefined): TimelineBucket | undefined {
	if (point === undefined || point < 0) return undefined;
	return buckets.find((bucket) => point >= bucket.first && point <= bucket.last);
}

export function availableTimelineZooms(timeline: ContextTimeline, width: number): TimelineZoom[] {
	const fitsWidth = timeline.points.length <= plotWidthFor(width);
	return TIMELINE_ZOOMS.filter((zoom) => !(fitsWidth && zoom === "requests"));
}

export function formatBucketSpan(timeline: ContextTimeline, bucket: TimelineBucket): string | undefined {
	return timeSpan(timeline, bucket.first, bucket.last);
}

export function bucketIndexOf(layout: TimelineLayout, point: number | undefined): number {
	if (point === undefined || point < 0) return -1;
	return layout.buckets.findIndex((bucket) => point >= bucket.first && point <= bucket.last);
}

function clockTime(at: string | undefined): string | undefined {
	if (!at) return undefined;
	const date = new Date(at);
	return Number.isNaN(date.valueOf()) ? undefined : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(milliseconds: number): string {
	const minutes = Math.round(milliseconds / 60_000);
	if (minutes < 1) return "<1 min";
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function timeSpan(timeline: ContextTimeline, first: number, last: number): string | undefined {
	const start = timeline.points[first]?.at;
	const end = timeline.points[last]?.at;
	const from = clockTime(start);
	const to = clockTime(end);
	if (!from) return undefined;
	if (first === last || !to || !start || !end) return from;
	return `${from}–${to} (${formatDuration(new Date(end).valueOf() - new Date(start).valueOf())})`;
}

export function describeTimelineBucket(timeline: ContextTimeline, bucket: TimelineBucket): string {
	const first = timeline.points[bucket.first];
	const last = timeline.points[bucket.last];
	if (!first || !last) return "";
	const parts =
		bucket.first === bucket.last
			? [`request ${first.request}`, `${formatTokenCount(bucket.tokens)} tok`]
			: [
					`requests ${first.request}–${last.request} (${bucket.last - bucket.first + 1})`,
					`peak ${formatTokenCount(bucket.tokens)} · last ${formatTokenCount(bucket.finalTokens)} tok`,
				];
	const span = timeSpan(timeline, bucket.first, bucket.last);
	if (span) parts.splice(1, 0, span);
	if (bucket.turns > 0) parts.push(`${bucket.turns} user turn${bucket.turns === 1 ? "" : "s"}`);
	if (bucket.edits.length > 0)
		parts.push(`${bucket.edits.length} accepted edit${bucket.edits.length === 1 ? "" : "s"}`);
	return parts.join(" · ");
}

export function renderTimelineChart(timeline: ContextTimeline, options: TimelineChartOptions): string[] {
	const id = (text: string) => text;
	const style = {
		bar: options.style?.bar ?? id,
		editBar: options.style?.editBar ?? id,
		marker: options.style?.marker ?? id,
		budget: options.style?.budget ?? id,
		axis: options.style?.axis ?? id,
		selected: options.style?.selected ?? id,
		selectedMarker: options.style?.selectedMarker ?? options.style?.selected ?? id,
		landmark: options.style?.landmark ?? options.style?.axis ?? id,
	};
	if (timeline.points.length === 0) {
		return ["No completed requests on this branch yet."];
	}
	const labelWidth = CHART_LABEL_WIDTH;
	const height = Math.max(4, options.height);
	const layout = layoutTimeline(timeline, options);
	const { buckets, columnWidth, gap } = layout;
	const cell = (glyph: string, styled: (text: string) => string) => styled(glyph.repeat(columnWidth)) + " ".repeat(gap);
	const budgetOnChart = options.budget !== undefined && options.budget <= Math.max(1, timeline.peakTokens) * 2;
	const ceiling = Math.max(timeline.peakTokens, budgetOnChart ? (options.budget ?? 0) : 0, 1);
	const selectedMarker = options.selectedMarker !== undefined ? timeline.markers[options.selectedMarker] : undefined;
	let selectedColumn = selectedMarker?.kind === "applied" ? bucketIndexOf(layout, selectedMarker.afterPoint) : -1;
	if (options.selectedPoint !== undefined) selectedColumn = bucketIndexOf(layout, options.selectedPoint);
	const budgetRow =
		budgetOnChart && options.budget !== undefined
			? height - 1 - Math.min(height - 1, Math.round((options.budget / ceiling) * (height - 1)))
			: undefined;

	const filledAt = (bucket: TimelineBucket, row: number) =>
		bucket.tokens >= ((height - row) / height) * ceiling - ceiling / height / 2 ||
		(row === height - 1 && bucket.tokens > 0);
	const topRows = buckets.map((bucket) => {
		for (let row = 0; row < height; row++) if (filledAt(bucket, row)) return row;
		return height;
	});
	const markerGlyph = (bucket: TimelineBucket, column: number) =>
		bucket.edits.length > 1
			? bucket.edits.length > 9
				? "+"
				: String(bucket.edits.length)
			: column === selectedColumn && selectedMarker !== undefined
				? "▼"
				: "▿";
	const markerCell = (bucket: TimelineBucket, column: number) => {
		const markerStyle = column === selectedColumn && selectedMarker !== undefined ? style.selectedMarker : style.marker;
		return (
			markerStyle(
				markerGlyph(bucket, column)
					.padStart(Math.ceil((columnWidth + 1) / 2))
					.padEnd(columnWidth),
			) + " ".repeat(gap)
		);
	};
	const markerRowOf = (column: number) =>
		defined(buckets[column]).edits.length > 0 ? defined(topRows[column]) - 1 : undefined;

	const rows: string[] = [];
	if (buckets.some((_bucket, column) => markerRowOf(column) === -1)) {
		const headroom = buckets
			.map((bucket, column) =>
				markerRowOf(column) === -1 ? markerCell(bucket, column) : " ".repeat(columnWidth + gap),
			)
			.join("");
		rows.push(`${" ".repeat(labelWidth)} ${headroom}`);
	}

	for (let row = 0; row < height; row++) {
		let label = "       ";
		if (row === 0) label = `${formatTokenCount(ceiling).padStart(6)} `;
		else if (row === Math.floor(height / 2)) label = `${formatTokenCount(ceiling / 2).padStart(6)} `;
		const cells = buckets
			.map((bucket, column) => {
				if (filledAt(bucket, row)) {
					if (column === selectedColumn) return cell("█", style.selected);
					const edited = bucket.edits.length > 0;
					return cell(edited ? "▓" : "█", edited ? style.editBar : style.bar);
				}
				if (markerRowOf(column) === row) return markerCell(bucket, column);
				if (budgetRow === row) return style.budget("╌".repeat(columnWidth + gap));
				return " ".repeat(columnWidth + gap);
			})
			.join("");
		const axisGlyph = budgetRow === row ? style.budget("┼") : style.axis("┤");
		rows.push(`${style.axis(label)}${axisGlyph}${cells}`);
	}
	const baselineCells = buckets
		.map((bucket) => {
			const landmark = layout.zoom !== "turns" && bucket.turns > 0;
			return (
				(landmark
					? style.landmark("•") + style.axis("─".repeat(columnWidth - 1))
					: style.axis("─".repeat(columnWidth))) + style.axis("─".repeat(gap))
			);
		})
		.join("");
	rows.push(`${style.axis("     0 ")}${style.axis("┴")}${baselineCells}`);

	const total = timeline.points.length;
	const firstShown = buckets[0]?.first ?? 0;
	const lastShown = buckets.at(-1)?.last ?? total - 1;
	const offChartBudget =
		options.budget !== undefined && !budgetOnChart ? ` · budget ${formatTokenCount(options.budget)} (above scale)` : "";
	let xLabel: string;
	if (layout.zoom === "requests") {
		const hiddenBefore = firstShown;
		const hiddenAfter = total - 1 - lastShown;
		const range =
			firstShown === lastShown ? `request ${firstShown + 1}` : `requests ${firstShown + 1}–${lastShown + 1}`;
		xLabel =
			hiddenBefore === 0 && hiddenAfter === 0
				? `${range} of ${total}`
				: `${hiddenBefore > 0 ? `◂ ${hiddenBefore} earlier  ` : ""}${range} of ${total}${hiddenAfter > 0 ? `  ${hiddenAfter} later ▸` : ""}`;
	} else if (layout.zoom === "fit") {
		xLabel =
			layout.requestsPerColumn === 1
				? `all ${total} requests`
				: `all ${total} requests · ${layout.requestsPerColumn}/column`;
	} else {
		const turns = turnGroupStarts(timeline).length;
		xLabel = `${turns} user turn${turns === 1 ? "" : "s"} · ${layout.turnsPerColumn}/column · ${total} requests`;
	}
	if (layout.zoom !== "requests") {
		const span = timeSpan(timeline, 0, total - 1);
		const withSpan = `${xLabel} · ${span}${offChartBudget}`;
		if (span && labelWidth + 1 + withSpan.length <= options.width) xLabel += ` · ${span}`;
	}
	rows.push(`${" ".repeat(labelWidth)} ${style.axis(xLabel + offChartBudget)}`);
	return rows;
}

export function formatMarkerRow(marker: TimelineMarker, timeline: ContextTimeline): string {
	const time = marker.at ? new Date(marker.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--:--";
	const request =
		marker.afterPoint >= 0
			? `after request ${timeline.points[marker.afterPoint]?.request ?? marker.afterPoint + 1}`
			: "before first request";
	if (marker.kind === "applied") {
		const before = marker.beforeTokens;
		const after = marker.afterTokens;
		const change =
			before !== undefined && after !== undefined && before > 0
				? ` ${after <= before ? "−" : "+"}${Math.abs(Math.round(((before - after) / before) * 100))}%`
				: "";
		const sizes =
			before !== undefined && after !== undefined
				? `${formatTokenCount(before)} → ${formatTokenCount(after)}${change}`
				: "size not recorded";
		return `r${marker.revision}  ${time}  edit accepted  ${sizes}  (${request})`;
	}
	if (marker.kind === "reset") return `r${marker.revision}  ${time}  reset to raw context  (${request})`;
	return `r${marker.revision}  ${time}  edit rejected: ${marker.message}  (${request})`;
}

export function formatMarkerCompact(marker: TimelineMarker): string {
	const time = clockTime(marker.at) ?? "--:--";
	if (marker.kind === "reset") return `r${marker.revision}  ${time}  reset to raw context`;
	if (marker.kind === "rejected") return `r${marker.revision}  ${time}  rejected: ${marker.message}`;
	const before = marker.beforeTokens;
	const after = marker.afterTokens;
	if (before === undefined || after === undefined) return `r${marker.revision}  ${time}  size not recorded`;
	const change =
		before > 0 ? `${after <= before ? "−" : "+"}${Math.abs(Math.round(((before - after) / before) * 100))}%` : "";
	return `r${marker.revision}  ${time}  ${formatTokenCount(before).padStart(5)} → ${formatTokenCount(after).padEnd(5)}  ${change}`.trimEnd();
}

export { clockTime as formatClockTime };

export function formatTimelineReport(timeline: ContextTimeline, width = 72, budget?: number): string {
	const lines = renderTimelineChart(timeline, { width, height: 8, budget });
	const applied = timeline.markers.filter((marker) => marker.kind === "applied");
	lines.push(
		"",
		applied.length === 0
			? "No accepted context edits yet."
			: `${applied.length} accepted context edit${applied.length === 1 ? "" : "s"}:`,
	);
	for (const marker of timeline.markers) lines.push(`  ${formatMarkerRow(marker, timeline)}`);
	return lines.join("\n");
}
