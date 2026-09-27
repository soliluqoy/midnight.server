import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type UserInput = { text: string; images?: ImageContent[] };

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	sideThreads: { isComposing(): boolean };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	takePastedImages: (text: string) => ImageContent[] | undefined;
	showSubmittedPrompt: (text: string) => void;
	onInputCallback?: (input: UserInput) => void;
	pendingUserInputs: UserInput[];
};

type InputContext = {
	onInputCallback?: (input: UserInput) => void;
	pendingUserInputs: UserInput[];
};

type PastedImagesContext = {
	pastedImages: Map<number, ImageContent>;
	pastedImageCounter: number;
};

type StartupSubmitContext = {
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
};

type InteractiveModePrivate = {
	handleStartupSubmit(this: StartupSubmitContext, text: string): void;
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<UserInput>;
	takePastedImages(this: PastedImagesContext, text: string): ImageContent[] | undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

const image = (data: string): ImageContent => ({ type: "image", data, mimeType: "image/png" });

function createSubmitContext(images?: ImageContent[]): SubmitContext {
	return {
		defaultEditor: {},
		sideThreads: { isComposing: () => false },
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		takePastedImages: vi.fn(() => images),
		showSubmittedPrompt: vi.fn(),
		pendingUserInputs: [],
	};
}

describe("InteractiveMode startup input", () => {
	it("restores a prompt submitted while managed-tool setup is running", () => {
		const context: StartupSubmitContext = {
			editor: { setText: vi.fn() },
			showStatus: vi.fn(),
		};

		interactiveModePrototype.handleStartupSubmit.call(context, "early prompt");

		expect(context.editor.setText).toHaveBeenCalledWith("early prompt");
		expect(context.showStatus).toHaveBeenCalledWith("Startup is still in progress");
	});

	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual([{ text: "early prompt", images: undefined }]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
		expect(context.showSubmittedPrompt).not.toHaveBeenCalled();
	});

	it("draws the prompt at once and passes pasted images with it", async () => {
		const pasted = [image("a")];
		const context = createSubmitContext(pasted);
		const onInput = vi.fn();
		context.onInputCallback = onInput;
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("what is this [image1]");

		expect(context.showSubmittedPrompt).toHaveBeenCalledWith("what is this [image1]");
		expect(onInput).toHaveBeenCalledWith({ text: "what is this [image1]", images: pasted });
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: [{ text: "queued prompt" }],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toEqual({ text: "queued prompt" });
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});
});

describe("InteractiveMode pasted images", () => {
	it("attaches only images whose markers remain, in marker order", () => {
		const context: PastedImagesContext = {
			pastedImages: new Map([
				[1, image("one")],
				[2, image("two")],
				[3, image("three")],
			]),
			pastedImageCounter: 3,
		};

		const images = interactiveModePrototype.takePastedImages.call(context, "[image3] then [image1] and [image3]");

		expect(images).toEqual([image("three"), image("one")]);
		expect(context.pastedImages.size).toBe(0);
		expect(context.pastedImageCounter).toBe(0);
	});

	it("returns undefined when no marker refers to a pasted image", () => {
		const context: PastedImagesContext = { pastedImages: new Map([[1, image("one")]]), pastedImageCounter: 1 };

		expect(interactiveModePrototype.takePastedImages.call(context, "plain [image2] text")).toBeUndefined();
	});
});
