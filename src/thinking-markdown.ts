import type { MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Models whose thinking blocks Midnight collapses by default. */
export function collapsibleThinkingModel(model: { provider?: string; id?: string } | undefined): boolean {
	return !!model && /deepseek/i.test(`${model.provider ?? ""}/${model.id ?? ""}`);
}

/**
 * Replaces long DeepSeek thinking blocks with one summary line while `collapsed()` is true.
 * Display only: saved history and model context keep the full reasoning text.
 */
export function collapseThinkingMarkdown(options: {
	collapsed: () => boolean;
	model: () => { provider?: string; id?: string } | undefined;
}): MarkdownTransformer {
	return (markdown, context) => {
		if (context.messageType !== "assistant-thinking" || !options.collapsed()) return markdown;
		if (!collapsibleThinkingModel(options.model()) || !markdown.trim()) return markdown;
		const lines = markdown.split("\n").length;
		const label = `Thinking hidden · ${lines} ${lines === 1 ? "line" : "lines"}`;
		const hint = " · /midnight thinking show";
		const width = Math.max(1, context.availableWidth);
		return truncateToWidth(label + (visibleWidth(label + hint) <= width ? hint : ""), width, "…");
	};
}
