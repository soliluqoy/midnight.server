import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type Component, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { type ThreadAnchor, toolCallAnchor } from "../../src/core/side-threads.ts";
import { TranscriptContainer } from "../../src/modes/interactive/components/transcript-container.ts";
import { SideThreadController, type SideThreadHost } from "../../src/modes/interactive/side-thread-controller.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

initTheme("dark");
setKeybindings(KeybindingsManager.create());

class FakeItem implements Component {
	readonly anchor: ThreadAnchor;
	constructor(anchor: ThreadAnchor) {
		this.anchor = anchor;
	}
	getThreadAnchorId(): string {
		return this.anchor.id;
	}
	getThreadAnchor(): ThreadAnchor {
		return this.anchor;
	}
	render(): string[] {
		return [`item ${this.anchor.label}`];
	}
	invalidate(): void {}
}

function setup(harness: Harness) {
	const transcript = new TranscriptContainer();
	const state = { editorText: "", bar: undefined as Component | undefined, focus: undefined as Component | undefined };
	const statuses: string[] = [];
	const host: SideThreadHost = {
		session: () => harness.session,
		transcript,
		requestRender: () => {},
		setFocus: (component) => {
			state.focus = component;
		},
		getEditorText: () => state.editorText,
		setEditorText: (text) => {
			state.editorText = text;
		},
		setBar: (component) => {
			state.bar = component;
		},
		reveal: () => {},
		showStatus: (message) => statuses.push(message),
		setRunningStatus: () => {},
	};
	const controller = new SideThreadController(host);
	transcript.decorations = controller;
	const lint = new FakeItem(
		toolCallAnchor(
			"bash",
			"call-1",
			{ command: "npm run check" },
			{ content: [{ type: "text", text: "lint/style/useConst footer.ts:160" }], isError: true },
			false,
		),
	);
	const edit = new FakeItem(toolCallAnchor("edit", "call-2", { path: "footer.ts" }, undefined, false));
	transcript.addChild(lint);
	transcript.addChild(edit);
	const press = (keys: string) => (state.focus as { handleInput(data: string): void }).handleInput(keys);
	return { transcript, controller, state, statuses, lint, edit, press };
}

describe("side threads", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("answers under the item without touching the main session", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { transcript, controller, lint } = setup(harness);
		let sideRequest = "";
		harness.setResponses([
			(context) => {
				sideRequest = context.messages.map((message) => getMessageText(message)).join("\n");
				return fauxAssistantMessage("Only lint: useConst at footer.ts:160.");
			},
		]);

		const choice = controller.resolveModel("same")!;
		await controller.ask(lint.anchor, "is it only lint?", choice);

		expect(sideRequest).toContain("Question: is it only lint?");
		expect(sideRequest).toContain("lint/style/useConst footer.ts:160");
		expect(harness.session.messages).toHaveLength(0);
		const text = transcript.render(80).join("\n");
		expect(text).toContain("item bash npm run check");
		expect(text).toContain("Only lint: useConst at footer.ts:160.");
		expect(controller.threads()[0]?.turns[0]).toMatchObject({ status: "done", question: "is it only lint?" });
	});

	it("runs while the main agent streams and leaves its turn unchanged", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { controller, lint } = setup(harness);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage("main answer");
			},
			fauxAssistantMessage("side answer"),
		]);

		const main = harness.session.prompt("main task");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(harness.session.isStreaming).toBe(true);
		await controller.ask(lint.anchor, "side?", controller.resolveModel("same")!);
		expect(controller.threads()[0]?.turns[0]?.answer).toBe("side answer");
		release();
		await main;

		const texts = harness.session.messages
			.filter((message) => message.role === "user" || message.role === "assistant")
			.map((message) => getMessageText(message));
		expect(texts).toEqual(["main task", "main answer"]);
	});

	it("selects items, keeps the main draft while composing, and sends to main only on request", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { transcript, controller, state, press } = setup(harness);
		harness.setResponses([fauxAssistantMessage("side answer")]);
		state.editorText = "my unfinished prompt";

		controller.toggleSelection();
		expect(controller.isSelecting()).toBe(true);
		expect(controller.selectedAnchorId()).toBe("tool:call-2");
		press("\x1b[A");
		expect(controller.selectedAnchorId()).toBe("tool:call-1");
		expect(transcript.render(80)[0]).toContain("▌ item bash npm run check");

		press("\r");
		expect(controller.isComposing()).toBe(true);
		expect(state.editorText).toBe("");
		controller.submitComposer("what failed?");
		expect(controller.isComposing()).toBe(false);
		expect(state.editorText).toBe("my unfinished prompt");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(controller.threads()[0]?.turns[0]?.answer).toBe("side answer");

		controller.toggleSelection();
		expect(controller.selectedAnchorId()).toBe("tool:call-1");
		press(" ");
		expect(transcript.render(80).join("\n")).toContain("▸ 1 side question");
		press("m");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.getPendingResponseCount()).toBe(0);
		const sent = harness.session.messages.find((message) => message.role === "custom");
		expect(getMessageText(sent)).toContain("Q: what failed?\nA (");
		expect(harness.session.isStreaming).toBe(false);

		press("d");
		expect(controller.threads()).toHaveLength(0);
		press("\x1b");
		expect(controller.isSelecting()).toBe(false);
		expect(state.bar).toBeUndefined();
	});

	it("restores the draft and returns to selection when a question is cancelled", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { controller, state, press } = setup(harness);
		state.editorText = "draft";
		controller.toggleSelection();
		press("\r");
		state.editorText = "half a question";
		controller.cancelComposer();
		expect(state.editorText).toBe("draft");
		expect(controller.isSelecting()).toBe(true);
	});

	it("folds a thread on click and selects an item on alt+click", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { transcript, controller, lint } = setup(harness);
		harness.setResponses([fauxAssistantMessage("answer line")]);
		await controller.ask(lint.anchor, "why?", controller.resolveModel("same")!);
		const click = (y: number, alt = false) =>
			transcript.handleMouse({
				type: "click",
				button: "left",
				x: 4,
				y,
				screenX: 4,
				screenY: y,
				width: 80,
				height: transcript.render(80).length,
				shift: false,
				alt,
				ctrl: false,
			});

		expect(transcript.render(80).join("\n")).toContain("answer line");
		expect(transcript.rowOf("tool:call-1")).toMatchObject({ start: 0 });
		expect(click(1)?.handled).toBe(true);
		const folded = transcript.render(80);
		expect(folded[1]).toContain("▸ 1 side question");
		expect(folded[1]).toContain('"why?" → answer line');
		expect(folded).toHaveLength(3);

		const editRow = transcript.rowOf("tool:call-2")!.start;
		expect(click(editRow)).toBeUndefined();
		expect(click(editRow, true)?.handled).toBe(true);
		expect(controller.isSelecting()).toBe(true);
		expect(controller.selectedAnchorId()).toBe("tool:call-2");
	});

	it("records errors from the model on the turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { controller, lint, transcript } = setup(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limited" })]);
		await controller.ask(lint.anchor, "why?", controller.resolveModel("same")!);
		expect(controller.threads()[0]?.turns[0]).toMatchObject({ status: "error", error: "rate limited" });
		expect(transcript.render(80).join("\n")).toContain("error: rate limited");
	});
});
