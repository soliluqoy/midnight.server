import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface DiffLine {
	line: number;
	text: string;
}

export type DiffOp =
	| { kind: "same"; left: DiffLine; right: DiffLine }
	| { kind: "removed"; left: DiffLine }
	| { kind: "added"; right: DiffLine };

export type SideBySideRow =
	| { kind: "same"; left: DiffLine; right: DiffLine }
	| { kind: "changed"; left: DiffLine; right: DiffLine }
	| { kind: "removed"; left: DiffLine }
	| { kind: "added"; right: DiffLine }
	| { kind: "skipped"; count: number }
	| { kind: "omitted"; count: number };

const MAX_LINE_CELLS = 1_000_000;
const MAX_WORD_CELLS = 40_000;
const MAX_LINE_CHARACTERS = 2_000;
const RESET = "\u001b[0m";

function splitLines(text: string): string[] {
	if (text === "") return [];
	return text.replace(/\r\n?/g, "\n").split("\n");
}

function lcsPairs<T>(a: readonly T[], b: readonly T[], maxCells: number): Array<[number, number]> | undefined {
	const n = a.length;
	const m = b.length;
	if (n === 0 || m === 0) return [];
	if ((n + 1) * (m + 1) > maxCells) return undefined;
	const width = m + 1;
	const table = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i * width + j] =
				a[i] === b[j]
					? table[(i + 1) * width + j + 1] + 1
					: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		}
	}
	const pairs: Array<[number, number]> = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			pairs.push([i, j]);
			i++;
			j++;
		} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	return pairs;
}

export function diffLines(before: string, after: string): DiffOp[] {
	const a = splitLines(before);
	const b = splitLines(after);
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	)
		suffix++;

	const ops: DiffOp[] = [];
	const same = (i: number, j: number) =>
		ops.push({
			kind: "same",
			left: { line: i + 1, text: a[i] },
			right: { line: j + 1, text: b[j] },
		});
	for (let index = 0; index < prefix; index++) same(index, index);

	const middleA = a.slice(prefix, a.length - suffix);
	const middleB = b.slice(prefix, b.length - suffix);
	const pairs = lcsPairs(middleA, middleB, MAX_LINE_CELLS) ?? [];
	let i = 0;
	let j = 0;
	const flushTo = (untilI: number, untilJ: number) => {
		for (; i < untilI; i++) ops.push({ kind: "removed", left: { line: prefix + i + 1, text: middleA[i] } });
		for (; j < untilJ; j++) ops.push({ kind: "added", right: { line: prefix + j + 1, text: middleB[j] } });
	};
	for (const [pi, pj] of pairs) {
		flushTo(pi, pj);
		same(prefix + i, prefix + j);
		i++;
		j++;
	}
	flushTo(middleA.length, middleB.length);

	for (let index = 0; index < suffix; index++) same(a.length - suffix + index, b.length - suffix + index);
	return ops;
}

export function sideBySideRows(ops: readonly DiffOp[], context = 3): SideBySideRow[] {
	if (!ops.some((op) => op.kind !== "same")) return [];
	const paired: SideBySideRow[] = [];
	for (let index = 0; index < ops.length; ) {
		const op = ops[index];
		if (op.kind === "same") {
			paired.push(op);
			index++;
			continue;
		}
		const removed: DiffLine[] = [];
		const added: DiffLine[] = [];
		while (index < ops.length && ops[index].kind === "removed") removed.push((ops[index++] as { left: DiffLine }).left);
		while (index < ops.length && ops[index].kind === "added") added.push((ops[index++] as { right: DiffLine }).right);
		const count = Math.max(removed.length, added.length);
		for (let k = 0; k < count; k++) {
			const left = removed[k];
			const right = added[k];
			if (left && right) paired.push({ kind: "changed", left, right });
			else if (left) paired.push({ kind: "removed", left });
			else if (right) paired.push({ kind: "added", right });
		}
	}

	const rows: SideBySideRow[] = [];
	for (let index = 0; index < paired.length; ) {
		if (paired[index].kind !== "same") {
			rows.push(paired[index++]);
			continue;
		}
		let end = index;
		while (end < paired.length && paired[end].kind === "same") end++;
		const run = paired.slice(index, end);
		const leading = index === 0;
		const trailing = end === paired.length;
		const keepHead = leading ? 0 : context;
		const keepTail = trailing ? 0 : context;
		if (run.length <= keepHead + keepTail + 1) {
			rows.push(...run);
		} else {
			rows.push(...run.slice(0, keepHead));
			rows.push({ kind: "skipped", count: run.length - keepHead - keepTail });
			rows.push(...run.slice(run.length - keepTail));
		}
		index = end;
	}
	return rows;
}

function rowLineCount(row: SideBySideRow): number {
	return row.kind === "skipped" || row.kind === "omitted" ? row.count : 1;
}

export function limitRows(rows: readonly SideBySideRow[], maxRows: number): SideBySideRow[] {
	if (rows.length <= maxRows) return [...rows];
	const kept = rows.slice(0, Math.max(0, maxRows));
	const count = rows.slice(kept.length).reduce((total, row) => total + rowLineCount(row), 0);
	return [...kept, { kind: "omitted", count }];
}

export interface WordSpan {
	text: string;
	changed: boolean;
}

function tokenize(text: string): string[] {
	return text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

function mergeSpans(tokens: readonly string[], changed: readonly boolean[]): WordSpan[] {
	const spans: WordSpan[] = [];
	for (const [index, token] of tokens.entries()) {
		const flag = changed[index];
		const last = spans.at(-1);
		if (last && last.changed === flag) last.text += token;
		else spans.push({ text: token, changed: flag });
	}
	return spans;
}

export function diffWords(before: string, after: string): { left: WordSpan[]; right: WordSpan[] } {
	const a = tokenize(before);
	const b = tokenize(after);
	const pairs = lcsPairs(a, b, MAX_WORD_CELLS);
	if (!pairs) {
		return {
			left: before ? [{ text: before, changed: true }] : [],
			right: after ? [{ text: after, changed: true }] : [],
		};
	}
	const leftChanged = a.map(() => true);
	const rightChanged = b.map(() => true);
	for (const [i, j] of pairs) {
		leftChanged[i] = false;
		rightChanged[j] = false;
	}
	const unmarkIsolatedSpace = (tokens: string[], changed: boolean[]) => {
		for (let k = 1; k < tokens.length - 1; k++) {
			if (!changed[k] && /^\s+$/.test(tokens[k]) && changed[k - 1] && changed[k + 1]) changed[k] = true;
		}
	};
	unmarkIsolatedSpace(a, leftChanged);
	unmarkIsolatedSpace(b, rightChanged);
	return { left: mergeSpans(a, leftChanged), right: mergeSpans(b, rightChanged) };
}

export interface DiffStyle {
	context(text: string): string;
	removed(text: string): string;
	added(text: string): string;
	emphasis(text: string): string;
	lineNumber(text: string): string;
	muted(text: string): string;
	title(text: string): string;
}

export interface SideBySideOptions {
	leftTitle: string;
	rightTitle: string;
	leftPlaceholder?: string;
	rightPlaceholder?: string;
}

export const MIN_SIDE_BY_SIDE_WIDTH = 60;

function sanitize(text: string): string {
	const unsafeControls = String.raw`[\u0000-\u0008\u000b-\u001f\u007f]`;
	const clean = text.replace(/\t/g, "   ").replace(new RegExp(unsafeControls, "g"), "�");
	return clean.length <= MAX_LINE_CHARACTERS
		? clean
		: `${clean.slice(0, MAX_LINE_CHARACTERS)}… (+${clean.length - MAX_LINE_CHARACTERS} chars)`;
}

function clipLine(text: string): string {
	return text.length <= MAX_LINE_CHARACTERS ? text : text.slice(0, MAX_LINE_CHARACTERS);
}

function omittedLabel(count: number): string {
	return `⋯ diff preview truncated: ${count} more line${count === 1 ? "" : "s"} not shown`;
}

function styledSide(spans: readonly WordSpan[], base: (text: string) => string, style: DiffStyle): string {
	return spans
		.map((span) => (span.changed ? base(style.emphasis(sanitize(span.text))) : base(sanitize(span.text))))
		.join("");
}

function wrapStyled(text: string, width: number): string[] {
	if (width <= 0) return [""];
	if (text === "") return [""];
	const wrapped = wrapTextWithAnsi(text, width);
	if (wrapped.length === 0) return [""];
	return text.includes("\u001b[") ? wrapped.map((line) => `${line}${RESET}`) : wrapped;
}

function padTo(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

interface RowSides {
	left?: { line: number; text: string };
	right?: { line: number; text: string };
	marker: string;
}

function rowSides(row: Exclude<SideBySideRow, { kind: "skipped" | "omitted" }>, style: DiffStyle): RowSides {
	if (row.kind === "same") {
		return {
			left: { line: row.left.line, text: style.context(sanitize(row.left.text)) },
			right: { line: row.right.line, text: style.context(sanitize(row.right.text)) },
			marker: style.muted("│"),
		};
	}
	if (row.kind === "removed") {
		return { left: { line: row.left.line, text: style.removed(sanitize(row.left.text)) }, marker: style.removed("−") };
	}
	if (row.kind === "added") {
		return { right: { line: row.right.line, text: style.added(sanitize(row.right.text)) }, marker: style.added("+") };
	}
	const words = diffWords(clipLine(row.left.text), clipLine(row.right.text));
	return {
		left: { line: row.left.line, text: styledSide(words.left, (t) => style.removed(t), style) },
		right: { line: row.right.line, text: styledSide(words.right, (t) => style.added(t), style) },
		marker: style.title("~"),
	};
}

function lineNumberWidth(rows: readonly SideBySideRow[]): number {
	let max = 1;
	for (const row of rows) {
		if (row.kind === "skipped" || row.kind === "omitted") continue;
		if ("left" in row && row.left) max = Math.max(max, row.left.line);
		if ("right" in row && row.right) max = Math.max(max, row.right.line);
	}
	return String(max).length;
}

export function renderSideBySide(
	rows: readonly SideBySideRow[],
	width: number,
	style: DiffStyle,
	options: SideBySideOptions,
): string[] {
	const columnWidth = Math.max(8, Math.floor((width - 3) / 2));
	const rightWidth = Math.max(8, width - 3 - columnWidth);
	const gutter = lineNumberWidth(rows);
	const leftText = Math.max(1, columnWidth - gutter - 1);
	const rightText = Math.max(1, rightWidth - gutter - 1);
	const fit = (text: string, target: number) => padTo(truncateToWidth(text, target, "…"), target);

	const lines: string[] = [
		fit(style.title(options.leftTitle), columnWidth) +
			style.muted(" │ ") +
			fit(style.title(options.rightTitle), rightWidth),
		style.muted(`${"─".repeat(columnWidth)}─┼─${"─".repeat(rightWidth)}`),
	];
	const content = (row: SideBySideRow) => row.kind !== "skipped" && row.kind !== "omitted";
	const hasLeft = rows.some((row) => content(row) && row.kind !== "added");
	const hasRight = rows.some((row) => content(row) && row.kind !== "removed");
	let placeholderLeft = !hasLeft ? options.leftPlaceholder : undefined;
	let placeholderRight = !hasRight ? options.rightPlaceholder : undefined;

	for (const row of rows) {
		if (row.kind === "skipped") {
			const label = style.muted(`⋯ ${row.count} unchanged line${row.count === 1 ? "" : "s"}`);
			lines.push(fit(label, columnWidth) + style.muted(" ┆ ") + fit(label, rightWidth));
			continue;
		}
		if (row.kind === "omitted") {
			lines.push(...wrapStyled(style.title(omittedLabel(row.count)), width));
			continue;
		}
		const sides = rowSides(row, style);
		const number = (line: number | undefined) =>
			style.lineNumber(line === undefined ? " ".repeat(gutter) : String(line).padStart(gutter, " "));
		const leftLines = sides.left
			? wrapStyled(sides.left.text, leftText)
			: placeholderLeft
				? wrapStyled(style.muted(placeholderLeft), leftText)
				: [""];
		const rightLines = sides.right
			? wrapStyled(sides.right.text, rightText)
			: placeholderRight
				? wrapStyled(style.muted(placeholderRight), rightText)
				: [""];
		if (!sides.left) placeholderLeft = undefined;
		if (!sides.right) placeholderRight = undefined;
		const height = Math.max(leftLines.length, rightLines.length);
		for (let k = 0; k < height; k++) {
			const left = `${number(k === 0 ? sides.left?.line : undefined)} ${padTo(leftLines[k] ?? "", leftText)}`;
			const right = `${number(k === 0 ? sides.right?.line : undefined)} ${padTo(rightLines[k] ?? "", rightText)}`;
			const marker = k === 0 ? sides.marker : style.muted("│");
			lines.push(`${padTo(left, columnWidth)} ${marker} ${right}`.trimEnd());
		}
	}
	return lines;
}

export function renderUnified(
	rows: readonly SideBySideRow[],
	width: number,
	style: DiffStyle,
	options: SideBySideOptions,
): string[] {
	const gutter = lineNumberWidth(rows);
	const textWidth = Math.max(1, width - gutter - 2);
	const lines = [style.title(`${options.leftTitle} → ${options.rightTitle}`)];
	const emit = (prefix: string, line: number | undefined, text: string) => {
		const wrapped = wrapStyled(text, textWidth);
		for (const [k, part] of wrapped.entries()) {
			const number = style.lineNumber(
				k === 0 && line !== undefined ? String(line).padStart(gutter, " ") : " ".repeat(gutter),
			);
			lines.push(`${k === 0 ? prefix : " "}${number} ${part}`.trimEnd());
		}
	};
	for (const row of rows) {
		if (row.kind === "skipped") {
			lines.push(style.muted(`${" ".repeat(gutter + 2)}⋯ ${row.count} unchanged line${row.count === 1 ? "" : "s"}`));
		} else if (row.kind === "omitted") {
			lines.push(...wrapStyled(style.title(omittedLabel(row.count)), width));
		} else if (row.kind === "same") {
			emit(" ", row.left.line, style.context(sanitize(row.left.text)));
		} else if (row.kind === "removed") {
			emit(style.removed("-"), row.left.line, style.removed(sanitize(row.left.text)));
		} else if (row.kind === "added") {
			emit(style.added("+"), row.right.line, style.added(sanitize(row.right.text)));
		} else {
			const words = diffWords(clipLine(row.left.text), clipLine(row.right.text));
			emit(
				style.removed("-"),
				row.left.line,
				styledSide(words.left, (t) => style.removed(t), style),
			);
			emit(
				style.added("+"),
				row.right.line,
				styledSide(words.right, (t) => style.added(t), style),
			);
		}
	}
	return lines;
}
