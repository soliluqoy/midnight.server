import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { compactWorkflowMarkdown } from "../src/workflow-markdown.ts";

const workflow = "Intro.\n\n```js workflow\nconst tasks = await runs.all([]);\nreturn tasks;\n```\n\nAfter.";
const context = { messageType: "assistant" as const, isStreaming: false, availableWidth: 80 };

test("workflow scripts collapse to a display-only label without changing surrounding text", () => {
	let enabled = true;
	const transform = compactWorkflowMarkdown(() => enabled);
	assert.equal(
		transform(workflow, context),
		"Intro.\n\nSubagent workflow · 2 lines · script hidden · /midnight compact off to view\n\nAfter.",
	);
	enabled = false;
	assert.equal(transform(workflow, context), workflow);
	assert.equal(transform(workflow, { ...context, messageType: "user" }), workflow);
	assert.equal(transform(workflow, { ...context, messageType: "assistant-thinking" }), workflow);
	enabled = true;
	const narrow = transform(workflow, { ...context, availableWidth: 30 });
	assert.ok(narrow.includes("Subagent workflow"));
	assert.ok(visibleWidth(narrow.split("\n")[2]) <= 30);
	assert.doesNotMatch(narrow, /const tasks/);
});

test("streaming workflow blocks hide partial scripts; unfinished saved text stays visible", () => {
	const transform = compactWorkflowMarkdown(() => true);
	const partial = "Starting.\n```js workflow\nconst secret = 42;";
	assert.equal(
		transform(partial, { ...context, isStreaming: true }),
		"Starting.\nSubagent workflow · preparing script · /midnight compact off to view",
	);
	assert.equal(transform(partial, context), partial);
});

test("ordinary JS fences and mentions of workflow syntax remain untouched", () => {
	const transform = compactWorkflowMarkdown(() => true);
	for (const source of [
		"```js\nconst task = 1;\n```",
		"`js workflow` is the subagent fence label.",
		"````md\n```js workflow\nexample\n```\n````",
		"```js workflow extra\nexample\n```",
	]) {
		assert.equal(transform(source, context), source);
	}
});
