import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { assistantAnchor, assistantAnchorId, type ThreadAnchor } from "../../../core/side-threads.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	private renderBlocks: Array<{ component: Markdown | Text; text: string }> = [];
	private renderStructureKey: string | undefined;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		// Theme colors are embedded in hidden/status Text components, so force a structural rebuild
		// rather than relying on the streaming fast path when the theme changes.
		this.renderStructureKey = undefined;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	getThreadAnchorId(): string | undefined {
		return this.lastMessage ? assistantAnchorId(this.lastMessage) : undefined;
	}

	/** Identity and text of this reply for side threads, once it has visible text. */
	getThreadAnchor(): ThreadAnchor | undefined {
		return this.lastMessage ? assistantAnchor(this.lastMessage) : undefined;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	private getRenderBlockSpecs(
		message: AssistantMessage,
	): Array<{ kind: "text" | "thinking"; text: string; runIndex?: number; hidden?: boolean; spacerAfter?: boolean }> {
		const specs: Array<{
			kind: "text" | "thinking";
			text: string;
			runIndex?: number;
			hidden?: boolean;
			spacerAfter?: boolean;
		}> = [];
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				specs.push({ kind: "text", text: content.text.trim() });
				continue;
			}
			if (content.type !== "thinking") continue;

			const thinkingBlocks: string[] = [];
			for (; i < message.content.length; i++) {
				const thinkingContent = message.content[i];
				if (thinkingContent.type !== "thinking") break;
				const thinking = thinkingContent.thinking.trim();
				if (thinking) thinkingBlocks.push(thinking);
			}
			i--;
			if (thinkingBlocks.length === 0) continue;

			const runIndex = thinkingRunIndex++;
			const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
			const spacerAfter = message.content
				.slice(i + 1)
				.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));
			specs.push({
				kind: "thinking",
				text: hidden ? this.hiddenThinkingLabel : thinkingBlocks.join("\n\n"),
				runIndex,
				hidden,
				spacerAfter,
			});
		}
		return specs;
	}

	private getRenderStructureKey(
		message: AssistantMessage,
		isStreaming: boolean,
		specs: ReturnType<typeof this.getRenderBlockSpecs>,
	): string {
		const hasToolCalls = message.content.some((content) => content.type === "toolCall");
		return JSON.stringify({
			isStreaming,
			outputPad: this.outputPad,
			hiddenThinkingLabel: this.hiddenThinkingLabel,
			hasToolCalls,
			stopReason: message.stopReason,
			errorMessage: message.errorMessage,
			blocks: specs.map((spec) => [spec.kind, spec.hidden ?? false, spec.spacerAfter ?? false]),
		});
	}

	private updateExistingBlocks(specs: ReturnType<typeof this.getRenderBlockSpecs>): void {
		if (specs.length !== this.renderBlocks.length) return;
		for (let index = 0; index < specs.length; index++) {
			const block = this.renderBlocks[index]!;
			const text = specs[index]!.text;
			if (block.text === text) continue;
			block.component.setText(text);
			block.text = text;
		}
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		const specs = this.getRenderBlockSpecs(message);
		const structureKey = this.getRenderStructureKey(message, isStreaming, specs);
		if (this.lastMessage && this.renderStructureKey === structureKey) {
			this.lastMessage = message;
			this.isStreaming = isStreaming;
			this.updateExistingBlocks(specs);
			return;
		}

		this.lastMessage = message;
		this.isStreaming = isStreaming;
		this.renderStructureKey = structureKey;
		this.renderBlocks = [];
		this.contentContainer.clear();

		if (specs.length > 0) this.contentContainer.addChild(new Spacer(1));
		for (const spec of specs) {
			let component: Markdown | Text;
			if (spec.kind === "text") {
				component = new Markdown(spec.text, this.outputPad, 0, this.markdownTheme, undefined, {
					transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
				});
			} else if (spec.hidden) {
				component = new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0);
			} else {
				component = new Markdown(
					spec.text,
					this.outputPad,
					0,
					this.markdownTheme,
					{ color: (text: string) => theme.fg("thinkingText", text), italic: true },
					{
						transform: createMarkdownTransform("assistant-thinking", this.isStreaming, this.markdownTransformers),
					},
				);
			}

			this.renderBlocks.push({ component, text: spec.text });
			if (spec.kind === "thinking") {
				const runIndex = spec.runIndex!;
				const hidden = spec.hidden === true;
				this.contentContainer.addChild(
					new MouseRegion(component, (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.thinkingVisibilityOverrides.set(runIndex, !hidden);
						if (this.lastMessage) this.updateContent(this.lastMessage);
						return { handled: true };
					}),
				);
				if (spec.spacerAfter) this.contentContainer.addChild(new Spacer(1));
			} else {
				this.contentContainer.addChild(component);
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((content) => content.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
