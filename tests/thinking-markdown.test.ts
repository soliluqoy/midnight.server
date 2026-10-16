import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { collapseThinkingMarkdown, collapsibleThinkingModel } from "../src/thinking-markdown.ts";

const thinking = ["First I look at the file.", "", "Then I plan the edit."].join("\n");

function transform(
	markdown: string,
	messageType: "user" | "assistant" | "assistant-thinking",
	{ collapsed = true, model = { provider: "deepseek", id: "deepseek-flash" }, availableWidth = 120 } = {},
) {
	return collapseThinkingMarkdown({ collapsed: () => collapsed, model: () => model })(markdown, {
		messageType,
		isStreaming: false,
		availableWidth,
	});
}

test("only DeepSeek thinking blocks collapse, and only while enabled", () => {
	assert.equal(collapsibleThinkingModel({ provider: "deepseek", id: "deepseek-flash" }), true);
	assert.equal(collapsibleThinkingModel({ provider: "openrouter", id: "deepseek/deepseek-chat" }), true);
	assert.equal(collapsibleThinkingModel({ provider: "openai", id: "gpt-6-sol" }), false);
	assert.equal(collapsibleThinkingModel(undefined), false);

	assert.equal(transform(thinking, "assistant-thinking"), "Thinking hidden · 3 lines · /midnight thinking show");
	assert.equal(transform(thinking, "assistant-thinking", { collapsed: false }), thinking);
	assert.equal(transform(thinking, "assistant-thinking", { model: { provider: "openai", id: "gpt-6-sol" } }), thinking);
	assert.equal(transform(thinking, "assistant"), thinking);
	assert.equal(transform(thinking, "user"), thinking);
	assert.equal(transform("   ", "assistant-thinking"), "   ");
});

test("the collapsed line drops the hint before it would be clipped", () => {
	assert.equal(
		stripTerminalSequences(transform(thinking, "assistant-thinking", { availableWidth: 24 })),
		"Thinking hidden · 3 lin…",
	);
	assert.equal(transform("Only one line", "assistant-thinking"), "Thinking hidden · 1 line · /midnight thinking show");
});
