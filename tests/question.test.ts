import assert from "node:assert/strict";
import { test } from "node:test";
import { formatQuestionOptions, formatQuestionTitle, type QuestionTheme, questionColumns } from "../src/question.ts";

const theme: QuestionTheme = {
	fg: (color, text) => `<${color}>${text}</>`,
	bold: (text) => `<b>${text}</>`,
};

test("options stay on one row while the label and trade-off fit", () => {
	assert.deepEqual(
		formatQuestionOptions([{ label: "Redis", description: "in-memory, extra service" }], { columns: 80, theme }),
		["• <b>Redis</> — <muted>in-memory, extra service</>"],
	);
	assert.deepEqual(formatQuestionOptions([{ label: "Redis", description: "" }], { columns: 80, theme }), [
		"• <b>Redis</>",
	]);
});

test("a long trade-off moves to an indented row and is clipped", () => {
	const [option] = formatQuestionOptions(
		[
			{
				label: "Postgres table",
				description: "reuses the existing database, slower under load, no new infrastructure",
			},
		],
		{ columns: 40, theme },
	);
	const lines = option.split("\n");
	assert.equal(lines.length, 2);
	assert.equal(lines[0], "• <b>Postgres table</>");
	// 40 columns - 2 padding - 2 marker - 2 indent - 2 marker = 32 columns, ellipsis included.
	assert.equal(lines[1], "  <dim>↳</> <muted>reuses the existing database, s…</>");
});

test("the choice marker is counted against the row width", () => {
	const fit = "x".repeat(26);
	const overflow = "x".repeat(27);
	// 40 columns - 4 for Pi's padding and marker leaves 36: "• Redis — " takes 10, so 26 characters fit.
	assert.deepEqual(formatQuestionOptions([{ label: "Redis", description: fit }], { columns: 40, theme }), [
		`• <b>Redis</> — <muted>${fit}</>`,
	]);
	assert.deepEqual(formatQuestionOptions([{ label: "Redis", description: overflow }], { columns: 40, theme }), [
		["• <b>Redis</>", `  <dim>↳</> <muted>${overflow}</>`].join("\n"),
	]);
});

test("labels are never clipped, so distinct options cannot render identically", () => {
	const label = "Option ".repeat(12).trim();
	assert.deepEqual(formatQuestionOptions([{ label, description: "" }], { columns: 24, theme }), [`• <b>${label}</>`]);
});

test("modes that render their own layout receive plain, untrimmed text", () => {
	const options = [{ label: "Redis", description: "in-memory, extra service that would not fit a narrow dialog row" }];
	assert.deepEqual(formatQuestionOptions(options), [
		"Redis — in-memory, extra service that would not fit a narrow dialog row",
	]);
	assert.deepEqual(formatQuestionOptions(options, { columns: 40 }), [
		"Redis — in-memory, extra service that would not fit a narrow dialog row",
	]);
});

test("the title marks the question and carries the answer notice when the placeholder is ignored", () => {
	assert.equal(formatQuestionTitle("Which cache?", { theme }), "<warning>?</> <b><borderAccent>Which cache?</></>");
	assert.equal(formatQuestionTitle("Which cache?"), "? Which cache?");
	assert.equal(
		formatQuestionTitle("Which cache?", { theme, notice: true }),
		"<warning>?</> <b><borderAccent>Which cache?</></>\n<muted>Saved in the conversation and sent to the model — do not enter secrets.</>",
	);
});

test("the render width follows Pi's own fallback order", () => {
	assert.equal(questionColumns({ columns: 132 }, {}), 132);
	assert.equal(questionColumns({}, { COLUMNS: "100" }), 100);
	assert.equal(questionColumns({}, {}), 80);
});
