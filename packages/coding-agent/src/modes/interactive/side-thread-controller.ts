import type { Api, Model } from "@earendil-works/pi-ai";
import { type Component, getKeybindings } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import {
	answerText,
	buildSideThreadRequest,
	formatThreadForMain,
	runSideThreadTurn,
	type SideThread,
	type SideThreadModelKind,
	SideThreadStore,
	type SideThreadTurn,
	sideThreadFileFor,
	type ThreadAnchor,
} from "../../core/side-threads.ts";
import { LOCAL_MODEL_ID, LOCAL_PROVIDER_ID, MODEL_LOCK } from "../../midnight/pins.ts";
import { getMidnightStatus } from "../../midnight/status.ts";
import { findModel } from "../../midnight/store.ts";
import {
	renderFoldedThread,
	renderOpenThread,
	ThreadComposerBar,
	ThreadSelectionBar,
} from "./components/side-thread.ts";
import type { TranscriptContainer, TranscriptDecorations } from "./components/transcript-container.ts";

/** The parts of interactive mode the controller uses. */
export interface SideThreadHost {
	session(): AgentSession;
	transcript: TranscriptContainer;
	requestRender(): void;
	/** Focus the thread selection bar, or the editor when undefined. */
	setFocus(component: Component | undefined): void;
	getEditorText(): string;
	setEditorText(text: string): void;
	/** Show a bar above the editor, or remove it. */
	setBar(component: Component | undefined): void;
	/** Scroll the transcript so an item is visible. `done` restores following the end. */
	reveal(anchorId: string | undefined): void;
	showStatus(message: string): void;
	/** Footer text while answers stream, or undefined when none are running. */
	setRunningStatus(text: string | undefined): void;
}

export interface SideThreadModelChoice {
	model: Model<Api>;
	kind: SideThreadModelKind;
}

type Mode =
	| { type: "idle" }
	| { type: "selecting" }
	| {
			type: "composing";
			anchor: ThreadAnchor;
			draft: string;
			choices: SideThreadModelChoice[];
			choiceIndex: number;
			fromSelection: boolean;
	  };

const RENDER_THROTTLE_MS = 50;

/**
 * Side threads in the interactive transcript: selection mode, the question composer,
 * model choice, and running turns. Nothing here touches the agent loop; the only way
 * a thread reaches the main agent is `sendSelectedToMain`.
 */
export class SideThreadController implements TranscriptDecorations {
	private readonly host: SideThreadHost;
	private store: SideThreadStore;
	private mode: Mode = { type: "idle" };
	private selectedId: string | undefined;
	private readonly open = new Set<string>();
	private readonly running = new Map<string, AbortController>();
	private readonly renderCache = new Map<string, { key: string; lines: string[] }>();
	private readonly selectionBar = new ThreadSelectionBar();
	private readonly composerBar = new ThreadComposerBar();
	private lastChoice: { provider: string; id: string } | undefined;
	private tickTimer: NodeJS.Timeout | undefined;
	private renderTimer: NodeJS.Timeout | undefined;

	constructor(host: SideThreadHost) {
		this.host = host;
		this.store = new SideThreadStore(sideThreadFileFor(host.session().sessionManager.getSessionFile()));
		this.selectionBar.onInput = (data) => this.handleSelectionInput(data);
	}

	// ---------------------------------------------------------------- state

	isSelecting(): boolean {
		return this.mode.type === "selecting";
	}

	isComposing(): boolean {
		return this.mode.type === "composing";
	}

	threads(): SideThread[] {
		this.syncStore();
		return this.store.all();
	}

	runningCount(): number {
		return this.running.size;
	}

	/** Reload threads when the session file changed (new, resume, fork). */
	private syncStore(): void {
		const file = sideThreadFileFor(this.host.session().sessionManager.getSessionFile());
		if (file === this.store.file) return;
		this.store = new SideThreadStore(file);
		this.open.clear();
		this.renderCache.clear();
		this.selectedId = undefined;
		if (this.mode.type !== "idle") this.exitToIdle();
	}

	// ------------------------------------------------------- transcript hooks

	/** Called once per transcript render, before `renderBelow`. */
	selectedAnchorId(): string | undefined {
		this.syncStore();
		return this.mode.type === "selecting" ? this.selectedId : undefined;
	}

	renderBelow(anchorId: string, width: number): string[] {
		const thread = this.store.get(anchorId);
		if (!thread || thread.turns.length === 0) return [];
		const isOpen = this.open.has(anchorId);
		const last = thread.turns[thread.turns.length - 1]!;
		const tick = last.status === "running" ? Math.floor((Date.now() - last.startedAt) / 1000) : 0;
		const key = `${isOpen}|${width}|${thread.turns.length}|${last.status}|${last.answer.length}|${thread.sentTurns}|${tick}`;
		const cached = this.renderCache.get(anchorId);
		if (cached?.key === key) return cached.lines;
		const lines = isOpen ? renderOpenThread(thread, width) : renderFoldedThread(thread, width);
		this.renderCache.set(anchorId, { key, lines });
		return lines;
	}

	onThreadClick(anchorId: string): void {
		this.toggle(anchorId);
	}

	onAnchorClick(anchorId: string): void {
		if (this.mode.type === "composing") return;
		if (this.mode.type !== "selecting") this.enterSelection();
		this.select(anchorId);
	}

	/** Theme or width changes invalidate every cached thread block. */
	invalidate(): void {
		this.renderCache.clear();
	}

	// -------------------------------------------------------------- selection

	/** alt+t: enter selection on the newest item, or leave it. */
	toggleSelection(): void {
		if (this.mode.type === "selecting") {
			this.exitToIdle();
			return;
		}
		if (this.mode.type === "composing") return;
		this.enterSelection();
	}

	private enterSelection(): boolean {
		const anchors = this.host.transcript.anchors();
		if (anchors.length === 0) {
			this.host.showStatus("Nothing to ask about yet: side threads attach to tool calls and replies");
			return false;
		}
		this.mode = { type: "selecting" };
		const ids = anchors.map((anchor) => anchor.getThreadAnchorId());
		if (!this.selectedId || !ids.includes(this.selectedId)) this.selectedId = ids[ids.length - 1];
		this.host.setBar(this.selectionBar);
		this.host.setFocus(this.selectionBar);
		this.updateSelectionBar();
		this.host.reveal(this.selectedId);
		return true;
	}

	private select(anchorId: string): void {
		this.selectedId = anchorId;
		this.updateSelectionBar();
		this.host.reveal(anchorId);
		this.host.requestRender();
	}

	private move(delta: number): void {
		const ids = this.host.transcript
			.anchors()
			.map((anchor) => anchor.getThreadAnchorId())
			.filter((id): id is string => !!id);
		if (ids.length === 0) return;
		const current = this.selectedId ? ids.indexOf(this.selectedId) : -1;
		const next = current < 0 ? ids.length - 1 : Math.max(0, Math.min(ids.length - 1, current + delta));
		this.select(ids[next]!);
	}

	private selectedAnchor(): ThreadAnchor | undefined {
		const component = this.host.transcript.anchors().find((anchor) => anchor.getThreadAnchorId() === this.selectedId);
		return component?.getThreadAnchor();
	}

	private updateSelectionBar(): void {
		const anchor = this.selectedAnchor();
		const thread = this.selectedId ? this.store.get(this.selectedId) : undefined;
		this.selectionBar.selectedLabel = anchor?.label ?? "";
		this.selectionBar.hasThread = !!thread && thread.turns.length > 0;
		this.selectionBar.running = !!this.selectedId && this.running.has(this.selectedId);
		this.host.requestRender();
	}

	private handleSelectionInput(data: string): void {
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.up")) this.move(-1);
		else if (keys.matches(data, "tui.select.down")) this.move(1);
		else if (keys.matches(data, "tui.select.pageUp")) this.move(-5);
		else if (keys.matches(data, "tui.select.pageDown")) this.move(5);
		else if (keys.matches(data, "app.thread.ask")) this.startComposerForSelection();
		else if (keys.matches(data, "app.thread.toggle")) {
			if (this.selectedId) this.toggle(this.selectedId);
		} else if (keys.matches(data, "app.thread.sendToMain")) void this.sendSelectedToMain();
		else if (keys.matches(data, "app.thread.delete")) this.deleteSelected();
		else if (keys.matches(data, "app.thread.stop")) this.stopSelected();
		else if (
			keys.matches(data, "tui.select.cancel") ||
			keys.matches(data, "app.thread.select") ||
			keys.matches(data, "app.interrupt")
		) {
			this.exitToIdle();
		}
	}

	private toggle(anchorId: string): void {
		const thread = this.store.get(anchorId);
		if (!thread || thread.turns.length === 0) return;
		if (this.open.has(anchorId)) this.open.delete(anchorId);
		else this.open.add(anchorId);
		this.host.requestRender();
	}

	private deleteSelected(): void {
		const id = this.selectedId;
		if (!id || !this.store.get(id)) return;
		this.running.get(id)?.abort();
		this.store.delete(id);
		this.open.delete(id);
		this.renderCache.delete(id);
		this.updateSelectionBar();
		this.host.showStatus("Side thread deleted");
	}

	private stopSelected(): void {
		if (this.selectedId) this.running.get(this.selectedId)?.abort();
	}

	/** Add the thread's unsent answers to the main context as a visible message. No turn starts. */
	async sendSelectedToMain(): Promise<void> {
		const thread = this.selectedId ? this.store.get(this.selectedId) : undefined;
		if (!thread) return;
		const unsent = thread.turns.slice(thread.sentTurns).filter((turn) => turn.status === "done");
		if (unsent.length === 0) {
			this.host.showStatus("Nothing new to send from this thread");
			return;
		}
		const session = this.host.session();
		const text = formatThreadForMain(thread);
		// A running answer is always the last turn; it is sent next time.
		const last = thread.turns[thread.turns.length - 1];
		thread.sentTurns = thread.turns.length - (last?.status === "running" ? 1 : 0);
		this.store.save();
		this.renderCache.delete(thread.anchorId);
		await session.sendCustomMessage(
			{ customType: "side-thread", content: text, display: true, details: { anchorId: thread.anchorId } },
			{ triggerTurn: false },
		);
		this.host.showStatus(
			session.isStreaming
				? "Side thread will be added to the main context when this turn ends"
				: "Side thread added to the main context",
		);
		this.updateSelectionBar();
	}

	private exitToIdle(): void {
		const wasComposing = this.mode.type === "composing" ? this.mode : undefined;
		this.mode = { type: "idle" };
		this.host.setBar(undefined);
		if (wasComposing) this.host.setEditorText(wasComposing.draft);
		this.host.setFocus(undefined);
		this.host.reveal(undefined);
		this.host.requestRender();
	}

	// --------------------------------------------------------------- composer

	private startComposerForSelection(): void {
		const anchor = this.selectedAnchor();
		if (anchor) this.startComposer(anchor, true);
	}

	/** Put the editor into side-question mode for `anchor`, keeping the main draft aside. */
	startComposer(anchor: ThreadAnchor, fromSelection = false, preferred?: SideThreadModelChoice): void {
		this.syncStore();
		const choices = this.modelChoices();
		if (choices.length === 0) {
			this.host.showStatus("No model available for side threads");
			return;
		}
		const draft = this.mode.type === "composing" ? this.mode.draft : this.host.getEditorText();
		this.mode = {
			type: "composing",
			anchor,
			draft,
			choices,
			choiceIndex: this.choiceIndex(anchor, choices, preferred),
			fromSelection,
		};
		this.host.setEditorText("");
		this.updateComposerBar();
		this.host.setBar(this.composerBar);
		this.host.setFocus(undefined);
	}

	private updateComposerBar(): void {
		if (this.mode.type !== "composing") return;
		const choice = this.mode.choices[this.mode.choiceIndex]!;
		this.composerBar.anchorLabel = this.mode.anchor.label;
		this.composerBar.modelLabel = this.choiceLabel(choice);
		this.composerBar.options = this.mode.choices.length;
		this.host.requestRender();
	}

	/** The side-question model, without changing the main session model. */
	composingModel(): Model<Api> | undefined {
		return this.mode.type === "composing" ? this.mode.choices[this.mode.choiceIndex]?.model : undefined;
	}

	selectComposerModel(model: Model<Api>): void {
		if (this.mode.type !== "composing") return;
		const session = this.host.session();
		const kind: SideThreadModelKind =
			model.provider === LOCAL_PROVIDER_ID
				? "local"
				: session.model?.provider === model.provider && session.model.id === model.id
					? "same"
					: "other";
		const index = this.mode.choices.findIndex(
			(choice) => choice.model.provider === model.provider && choice.model.id === model.id,
		);
		if (index < 0) this.mode.choices.push({ model, kind });
		else this.mode.choices[index] = { model, kind };
		this.mode.choiceIndex = index < 0 ? this.mode.choices.length - 1 : index;
		this.lastChoice = { provider: model.provider, id: model.id };
		this.updateComposerBar();
	}

	cycleModel(direction: 1 | -1): void {
		if (this.mode.type !== "composing") return;
		const count = this.mode.choices.length;
		this.mode.choiceIndex = (this.mode.choiceIndex + direction + count) % count;
		const choice = this.mode.choices[this.mode.choiceIndex]!;
		this.lastChoice = { provider: choice.model.provider, id: choice.model.id };
		this.updateComposerBar();
	}

	/** Escape in the composer: restore the main draft, and return to selection if it came from there. */
	cancelComposer(): void {
		if (this.mode.type !== "composing") return;
		const { draft, fromSelection } = this.mode;
		this.mode = { type: "idle" };
		this.host.setEditorText(draft);
		if (!fromSelection || !this.enterSelection()) this.exitToIdle();
	}

	submitComposer(text: string): void {
		if (this.mode.type !== "composing") return;
		const question = text.trim();
		if (!question) return;
		const { anchor, choices, choiceIndex } = this.mode;
		this.selectedId = anchor.id;
		this.exitToIdle();
		void this.ask(anchor, question, choices[choiceIndex]!);
	}

	// ----------------------------------------------------------------- models

	private localModel(): Model<Api> | undefined {
		return this.host.session().modelRuntime.getModel(LOCAL_PROVIDER_ID, LOCAL_MODEL_ID);
	}

	/** Local model (if registered), the session model, then the ctrl+p scoped models. */
	modelChoices(): SideThreadModelChoice[] {
		const session = this.host.session();
		const choices: SideThreadModelChoice[] = [];
		const add = (model: Model<Api> | undefined, kind: SideThreadModelKind) => {
			if (
				!model ||
				choices.some((choice) => choice.model.provider === model.provider && choice.model.id === model.id)
			) {
				return;
			}
			choices.push({ model, kind: model.provider === LOCAL_PROVIDER_ID ? "local" : kind });
		};
		add(this.localModel(), "local");
		add(session.model, "same");
		for (const scoped of session.scopedModels) add(scoped.model, "other");
		if (this.lastChoice) {
			add(
				session.modelRuntime
					.getAvailableSnapshot()
					.find((model) => model.provider === this.lastChoice?.provider && model.id === this.lastChoice.id),
				"other",
			);
		}
		return choices;
	}

	private choiceLabel(choice: SideThreadModelChoice): string {
		const session = this.host.session();
		const isSession = session.model?.provider === choice.model.provider && session.model.id === choice.model.id;
		if (choice.kind === "local") return isSession ? "local (session model)" : "local";
		return isSession ? `${choice.model.id} (same as main)` : choice.model.id;
	}

	/**
	 * The last model picked in this run, else the local model for tool output when it is
	 * already installed (no surprise download), else the session model.
	 */
	private choiceIndex(
		anchor: ThreadAnchor,
		choices: SideThreadModelChoice[],
		preferred?: SideThreadModelChoice,
	): number {
		if (preferred) {
			const index = choices.findIndex(
				(choice) => choice.model.provider === preferred.model.provider && choice.model.id === preferred.model.id,
			);
			if (index >= 0) return index;
			choices.push(preferred);
			return choices.length - 1;
		}
		if (this.lastChoice) {
			const index = choices.findIndex(
				(choice) => choice.model.provider === this.lastChoice!.provider && choice.model.id === this.lastChoice!.id,
			);
			if (index >= 0) return index;
		}
		const localIndex = choices.findIndex((choice) => choice.kind === "local");
		const localReady = getMidnightStatus().engine === "ready" || findModel(MODEL_LOCK) !== undefined;
		if (anchor.id.startsWith("tool:") && localIndex >= 0 && localReady) return localIndex;
		const sessionIndex = choices.findIndex((choice) => choice.kind === "same");
		return sessionIndex >= 0 ? sessionIndex : 0;
	}

	/** Resolve `local`, `same`, or `provider/id` (or a bare id) for `/ask @model`. */
	resolveModel(spec: string): SideThreadModelChoice | undefined {
		const choices = this.modelChoices();
		if (spec === "local") return choices.find((choice) => choice.kind === "local");
		if (spec === "same") {
			const model = this.host.session().model;
			return model ? { model, kind: model.provider === LOCAL_PROVIDER_ID ? "local" : "same" } : undefined;
		}
		const runtime = this.host.session().modelRuntime;
		const slash = spec.indexOf("/");
		const model =
			slash > 0
				? runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1))
				: runtime.getModels().find((candidate) => candidate.id === spec);
		if (!model) return undefined;
		const session = this.host.session();
		const same = session.model?.provider === model.provider && session.model.id === model.id;
		return { model, kind: model.provider === LOCAL_PROVIDER_ID ? "local" : same ? "same" : "other" };
	}

	// -------------------------------------------------------------------- run

	/** The newest item in the transcript, for `/ask` without selection. */
	latestAnchor(): ThreadAnchor | undefined {
		const anchors = this.host.transcript.anchors();
		return anchors[anchors.length - 1]?.getThreadAnchor();
	}

	/** `/ask` with a question: use `choice`, or the model the composer would default to. */
	async askAbout(anchor: ThreadAnchor, question: string, choice?: SideThreadModelChoice): Promise<void> {
		const choices = this.modelChoices();
		const resolved = choice ?? choices[this.choiceIndex(anchor, choices)];
		if (!resolved) {
			this.host.showStatus("No model available for side threads");
			return;
		}
		this.selectedId = anchor.id;
		await this.ask(anchor, question, resolved);
	}

	/** Ask `question` about `anchor`. Resolves when the answer is complete. */
	async ask(anchor: ThreadAnchor, question: string, choice: SideThreadModelChoice): Promise<void> {
		this.syncStore();
		if (this.running.has(anchor.id)) {
			this.host.showStatus("This item's side thread is still answering");
			return;
		}
		const store = this.store;
		const thread = store.getOrCreate(anchor.id, anchor.label, anchor.excerpt);
		// A tool that was still running when the thread started has more output now.
		thread.excerpt = anchor.excerpt;
		thread.anchorLabel = anchor.label;
		const turn: SideThreadTurn = {
			question,
			answer: "",
			model: { provider: choice.model.provider, id: choice.model.id, kind: choice.kind },
			status: "running",
			startedAt: Date.now(),
		};
		const session = this.host.session();
		const controller = new AbortController();
		const request = buildSideThreadRequest({
			model: choice.model,
			kind: choice.kind,
			thread,
			question,
			lastRequest: choice.kind === "same" ? session.getLastSessionRequest() : undefined,
			transcript: session.state.messages,
			signal: controller.signal,
		});
		thread.turns.push(turn);
		this.open.add(anchor.id);
		this.running.set(anchor.id, controller);
		this.host.setRunningStatus(this.statusText());
		store.save();
		this.startTicking();
		this.host.requestRender();
		try {
			const message = await runSideThreadTurn(session.modelRuntime, request, (answer) => {
				turn.answer = answer;
				this.scheduleRender();
			});
			if (message.stopReason === "aborted") {
				turn.status = "aborted";
			} else if (message.stopReason === "error") {
				turn.status = "error";
				turn.error = message.errorMessage ?? "request failed";
			} else {
				turn.status = "done";
				turn.answer = answerText(message);
			}
		} catch (error) {
			turn.status = controller.signal.aborted ? "aborted" : "error";
			if (turn.status === "error") turn.error = error instanceof Error ? error.message : String(error);
		} finally {
			turn.finishedAt = Date.now();
			this.running.delete(anchor.id);
			this.host.setRunningStatus(this.statusText());
			store.save();
			if (this.running.size === 0) this.stopTicking();
			if (this.mode.type === "selecting") this.updateSelectionBar();
			this.host.requestRender();
		}
	}

	/** Stop every running answer, e.g. on shutdown. */
	abortAll(): void {
		for (const controller of this.running.values()) controller.abort();
		this.stopTicking();
	}

	private scheduleRender(): void {
		if (this.renderTimer) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			this.host.requestRender();
		}, RENDER_THROTTLE_MS);
		this.renderTimer.unref?.();
	}

	/** Redraw once a second so "answering… 4s" advances between stream events. */
	private startTicking(): void {
		if (this.tickTimer) return;
		this.tickTimer = setInterval(() => this.host.requestRender(), 1000);
		this.tickTimer.unref?.();
	}

	private stopTicking(): void {
		if (this.tickTimer) clearInterval(this.tickTimer);
		this.tickTimer = undefined;
	}

	private statusText(): string | undefined {
		if (this.running.size === 0) return undefined;
		return this.running.size === 1 ? "⧉ 1 thread running" : `⧉ ${this.running.size} threads running`;
	}
}
