import type { MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const OPEN = "```js workflow";
const CLOSE = /^`{3,}[ \t]*$/;

export function compactWorkflowMarkdown(enabled: () => boolean): MarkdownTransformer {
	return (markdown, context) => {
		if (!enabled() || context.messageType !== "assistant" || !markdown.includes(OPEN)) return markdown;
		const lines = markdown.split("\n");
		let fence = false;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!fence && line === OPEN) {
				let end = i + 1;
				while (end < lines.length && !CLOSE.test(lines[end])) end++;
				if (end === lines.length && !context.isStreaming) return markdown;
				const count = end - i - 1;
				const label =
					end === lines.length
						? "Subagent workflow · preparing script"
						: `Subagent workflow · ${count} ${count === 1 ? "line" : "lines"} · script hidden`;
				const hint = " · /midnight compact off to view";
				const width = Math.max(1, context.availableWidth);
				const summary = truncateToWidth(label + (visibleWidth(label + hint) <= width ? hint : ""), width, "…");
				lines.splice(i, end === lines.length ? end - i : end - i + 1, summary);
				return lines.join("\n");
			}
			if (/^`{3,}/.test(line)) fence = !fence;
		}
		return markdown;
	};
}
