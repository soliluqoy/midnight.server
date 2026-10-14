import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { alignColumns, truncateLeftToWidth } from "../src/presentation.ts";

const plain = stripTerminalSequences;

test("left clipping keeps filenames and complete CJK, combining, and emoji graphemes", () => {
	for (const [text, width, expected] of [
		["long/prefix/theme.ts", 9, "…theme.ts"],
		["long/prefix/e\u0301.ts", 5, "…e\u0301.ts"],
		["long/prefix/文档.ts", 8, "…文档.ts"],
		["long/prefix/👨‍👩‍👧‍👦.ts", 6, "…👨‍👩‍👧‍👦.ts"],
	] as const) {
		const result = truncateLeftToWidth(text, width);
		assert.equal(plain(result), expected);
		assert.ok(visibleWidth(result) <= width);
	}
	assert.equal(truncateLeftToWidth("theme.ts", 20), "theme.ts");
	assert.equal(truncateLeftToWidth("theme.ts", 0), "");
	assert.equal(plain(truncateLeftToWidth("theme.ts", 1)), "…");
});

test("column pairs retain right-hand values and fit tiny and styled layouts", () => {
	const right = "\x1b[32m+128 −9\x1b[39m";
	const row = alignColumns("\x1b[34m文档.ts\x1b[39m", right, 24);
	assert.equal(visibleWidth(row), 24);
	assert.ok(plain(row).endsWith("+128 −9"));
	for (const width of [0, 1, 2, 4, 8, 16, 36]) {
		const result = alignColumns("a very long label", right, width);
		assert.equal(visibleWidth(result), width);
	}
});
