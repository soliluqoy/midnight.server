import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, isKeyRelease, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { compactToolRenderers } from "./compact-tools.ts";
import { registerSuite } from "./core/suite.ts";
import { type EvidenceDisplaySummary, EvidenceLedger } from "./evidence/model.ts";
import { registerEvidence } from "./evidence/register.ts";
import { ExplorerLocation, resolveExplorerFolder } from "./explorer-location.ts";
import { FileExplorerComponent } from "./file-explorer.ts";
import { FilePreviewComponent, type FilePreviewContent, loadFilePreview } from "./file-preview.ts";
import { createKeybindings } from "./keys.ts";
import { focusedComponent, type PanelMode, SidebarLayout } from "./layout.ts";
import { OPEN_PROJECT, ProjectSwitcher, SWITCH_PROJECT } from "./project-switch.ts";
import { registerQuestion } from "./question.ts";
import { sessionDiffSections } from "./session-diff.ts";
import { type PendingFile, SessionPendingFiles } from "./session-pending-files.ts";
import { SessionTitle } from "./session-title.ts";
import { Sidebar } from "./sidebar.ts";
import { applyDefaultTheme } from "./theme.ts";
import { registerTokenSpeed } from "./token-speed.ts";
import { registerTriage, type TriageStatus } from "./triage/index.ts";

export class MidnightPanels {
	private ctx: ExtensionContext;
	private readonly pi: ExtensionAPI;
	private readonly tui: TUI;
	private readonly workspace: ExplorerLocation;
	private readonly sidebar: Sidebar;
	private readonly pendingFiles: SessionPendingFiles;
	private readonly explorer: FileExplorerComponent;
	readonly layout: SidebarLayout;
	private readonly keys = createKeybindings();
	private prompt: Component | null;
	private disposed = false;
	private refreshTask: Promise<void> | undefined;
	private pendingRefresh = false;
	private controller = new AbortController();
	private unsubscribe: () => void;
	private closePreview: (() => void) | undefined;
	private previewGeneration = 0;
	private sessionPreviewRequest = 0;
	private layoutCheckQueued = false;
	private explorerVisible = false;
	private folderDialogOpen = false;
	private modelDialogOpen = false;
	private readonly projectSwitchActive: () => boolean;
	private readonly questionActive: () => boolean;

	constructor(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		tui: TUI,
		projectSwitchActive: () => boolean = () => false,
		questionActive: () => boolean = () => false,
	) {
		this.pi = pi;
		this.ctx = ctx;
		this.tui = tui;
		this.projectSwitchActive = projectSwitchActive;
		this.questionActive = questionActive;
		this.prompt = focusedComponent(tui);
		this.pendingFiles = new SessionPendingFiles(ctx.cwd);
		this.sidebar = new Sidebar(
			() => this.ctx,
			pi,
			() => tui.terminal.rows,
			(change) => void this.previewPending(change),
			() => void this.selectModel(),
			() => this.layout.autoCompactEnabled(),
			() => {
				if (!this.disposed) tui.requestRender();
			},
			() => this.questionActive(),
		);
		this.workspace = new ExplorerLocation(ctx.cwd, (reset) => {
			this.explorer.setSnapshot(this.workspace, reset);
			tui.requestRender();
		});
		this.explorer = new FileExplorerComponent({
			theme: () => this.ctx.ui.theme,
			keybindings: this.keys,
			inputBlocked: () => this.questionActive(),
			isProjectRoot: () => relative(this.workspace.projectRoot, this.workspace.root) === "",
			rootPath: () => this.workspace.root,
			sessionChanges: () => this.workspace.sessionChanges(this.sidebar.changedPaths),
			getHeight: () => tui.terminal.rows,
			onExpand: (path) => void this.workspace.load(path).catch((error) => this.folderError(error)),
			onOpen: (path) => this.insert(this.workspace.reference(path)),
			onPreview: (path) => void this.preview(this.workspace.reference(path)),
			onFolder: () => void this.browseFolder(),
			onParent: () => void this.browseFolder(dirname(this.workspace.root)),
			onProject: () => void this.browseFolder(this.workspace.projectRoot),
			onExit: () => this.exitExplorer(),
			onToggle: () => this.toggleExplorer(),
			onPassthrough: (data) => {
				this.exitExplorer();
				this.prompt?.handleInput?.(data);
			},
		});
		this.layout = new SidebarLayout(tui, this.sidebar, this.explorer, () => this.workspace.root);
		this.unsubscribe = ctx.ui.onTerminalInput((data) => this.handleTerminalInput(data));
		this.sidebar.refresh();
		this.layout.ensure();
		this.explorerVisible = this.layout.visibility().explorer;
		void this.refreshFiles();
	}

	private handleTerminalInput(data: string) {
		if (
			this.disposed ||
			this.folderDialogOpen ||
			this.questionActive() ||
			this.projectSwitchActive() ||
			isKeyRelease(data) ||
			this.tui.hasOverlay()
		)
			return;
		this.layout.ensure();
		if (this.explorer.focused && !this.layout.visibility().explorer) this.exitExplorer();
		if (this.keys.matches(data, "app.sidebar.toggle")) {
			this.toggleSidebar();
			return { consume: true };
		}
		if (this.keys.matches(data, "app.explorer.toggle")) {
			this.toggleExplorer();
			return { consume: true };
		}
		return;
	}

	update(ctx: ExtensionContext, scan: boolean): void {
		this.ctx = ctx;
		this.sidebar.refresh(scan);
		this.tui.requestRender();
	}

	updateTriage(status: TriageStatus | undefined): void {
		if (this.disposed) return;
		this.sidebar.triage = status;
		this.sidebar.invalidate();
		this.tui.requestRender();
	}

	updateEvidence(summary: EvidenceDisplaySummary): void {
		if (this.disposed) return;
		this.sidebar.evidence = summary;
		this.sidebar.invalidate();
		this.tui.requestRender();
	}

	render(): string[] {
		if (this.layoutCheckQueued || this.disposed) return [];
		this.layoutCheckQueued = true;
		queueMicrotask(() => {
			this.layoutCheckQueued = false;
			if (this.disposed) return;
			this.layout.ensure();
			const visible = this.layout.visibility().explorer;
			if (visible && !this.explorerVisible) void this.refreshFiles();
			this.explorerVisible = visible;
			if (this.explorer.focused && !visible) this.exitExplorer();
		});
		return [];
	}

	invalidate(): void {
		this.sidebar.invalidate();
	}

	toggleSidebar(): void {
		if (!this.supported()) return;
		this.layout.sidebarMode = this.layout.visibility().sidebar ? "hidden" : "always";
		this.sidebar.refresh(false);
		this.tui.requestRender();
	}

	toggleExplorer(): void {
		if (!this.supported()) return;
		if (this.explorer.focused) {
			this.layout.explorerMode = "hidden";
			this.exitExplorer();
		} else {
			this.layout.explorerMode = "always";
			if (!this.layout.visibility().explorer) {
				this.ctx.ui.notify("Explorer needs at least 72 terminal columns.", "info");
				return;
			}
			this.prompt = focusedComponent(this.tui) ?? this.prompt;
			this.tui.setFocus(this.explorer);
			this.explorerVisible = true;
			void this.refreshFiles();
		}
		this.tui.requestRender();
	}

	prepareQuestion(): boolean {
		if (this.disposed || this.folderDialogOpen || this.modelDialogOpen || this.projectSwitchActive()) return false;
		this.previewGeneration++;
		this.sessionPreviewRequest++;
		this.closePreview?.();
		this.exitExplorer();
		return true;
	}

	async browseFolder(input?: string): Promise<void> {
		if (this.disposed || this.folderDialogOpen || this.projectSwitchActive() || !this.supported()) return;
		const restoreFocus = this.explorer.focused;
		let switchProject = false;
		if (input === undefined) {
			this.folderDialogOpen = true;
			try {
				const destinations = [
					{ name: "Parent folder", path: dirname(this.workspace.root) },
					{ name: "Project folder", path: this.workspace.projectRoot },
					{ name: "Home folder", path: homedir() },
				];
				const labels = destinations.map(({ name, path }) => `${name} · ${stripTerminalSequences(path)}`);
				const enterPath = "Enter path…";
				const options = { signal: this.controller.signal };
				const selected = await this.ctx.ui.select(
					`Go to folder · ${stripTerminalSequences(this.workspace.root)}`,
					[...labels, enterPath, OPEN_PROJECT, SWITCH_PROJECT],
					options,
				);
				switchProject = selected === OPEN_PROJECT || selected === SWITCH_PROJECT;
				if (!this.disposed && (selected === enterPath || selected === SWITCH_PROJECT)) {
					input = await this.ctx.ui.input("Enter folder path", "Absolute path, relative path, or ~", options);
				} else if (selected === OPEN_PROJECT) input = this.workspace.root;
				else input = destinations[labels.indexOf(selected ?? "")]?.path;
			} finally {
				this.folderDialogOpen = false;
			}
		}
		if (this.disposed) return;
		if (restoreFocus && this.layout.visibility().explorer && !this.tui.hasOverlay()) {
			this.tui.setFocus(this.explorer);
			this.tui.requestRender();
		}
		if (!input?.trim()) return;
		if (switchProject) {
			this.exitExplorer();
			this.pi.sendUserMessage(`/midnight project ${resolveExplorerFolder(input, this.workspace.root)}`, {
				expandPromptTemplates: true,
			});
			return;
		}
		this.layout.explorerMode = "always";
		this.explorerVisible = this.layout.visibility().explorer;
		if (this.explorerVisible && !this.tui.hasOverlay()) {
			if (focusedComponent(this.tui) !== this.explorer) this.prompt = focusedComponent(this.tui) ?? this.prompt;
			this.tui.setFocus(this.explorer);
		}
		try {
			await this.workspace.go(input);
		} catch (error) {
			this.folderError(error);
		}
		if (!this.disposed) this.tui.requestRender();
	}

	private folderError(error: unknown): void {
		if (!this.disposed)
			this.ctx.ui.notify(
				stripTerminalSequences(`Cannot open folder: ${error instanceof Error ? error.message : error}`),
				"warning",
			);
	}

	setMode(panel: "sidebar" | "explorer", mode: PanelMode): void {
		if (panel === "sidebar") this.layout.sidebarMode = mode;
		else {
			this.layout.explorerMode = mode;
			if (mode === "hidden") this.exitExplorer();
		}
		this.tui.requestRender();
	}

	private supported(): boolean {
		if (this.questionActive()) return false;
		if (this.layout.ensure()) return true;
		this.ctx.ui.notify(
			"Midnight panels require pi 1.2.0 fullscreen mode. Set TUI mode to fullscreen in /settings.",
			"warning",
		);
		return false;
	}

	private exitExplorer(): void {
		if (focusedComponent(this.tui) === this.explorer) this.tui.setFocus(this.prompt);
		this.explorer.focused = false;
		this.tui.requestRender();
	}

	private insert(path: string): void {
		const reference = /\s|["\\]/.test(path) ? `@${JSON.stringify(path)}` : `@${path}`;
		this.ctx.ui.pasteToEditor(`${reference} `);
		this.exitExplorer();
	}

	private async previewPending(previous: PendingFile): Promise<void> {
		if (this.questionActive()) return;
		const request = ++this.sessionPreviewRequest;
		await this.refreshFiles();
		if (this.disposed || request !== this.sessionPreviewRequest) return;
		const generation = this.previewGeneration;
		const snapshot = this.pendingFiles.snapshot;
		const row = snapshot.rows.find(
			(row) => row.history.path === previous.history.path || row.absolute === previous.absolute,
		);
		if (!row || row.state === "clean") {
			this.ctx.ui.notify("No pending changes remain for this session file.", "info");
			return;
		}
		const sections =
			row.state === "pending"
				? await this.pendingFiles.preview(row)
				: [
						{ title: "Recorded operations — not current diff", message: row.reason ?? "Status unavailable" },
						...sessionDiffSections(row.history),
					];
		if (
			this.disposed ||
			request !== this.sessionPreviewRequest ||
			generation !== this.previewGeneration ||
			snapshot !== this.pendingFiles.snapshot ||
			this.sidebar.updating
		)
			return;
		await this.preview(row.path, { kind: "diff", sections });
	}

	private async preview(path: string, sessionContent?: FilePreviewContent): Promise<void> {
		if (this.questionActive()) return;
		if (!sessionContent) this.sessionPreviewRequest++;
		const generation = ++this.previewGeneration;
		this.closePreview?.();
		const content = sessionContent ?? (await loadFilePreview(resolve(this.ctx.cwd, path)));
		if (this.disposed || generation !== this.previewGeneration || this.questionActive()) return;
		await this.ctx.ui.custom<void>(
			(tui, _theme, _keys, done) => {
				this.closePreview = () => done();
				return new FilePreviewComponent({
					theme: () => this.ctx.ui.theme,
					keybindings: this.keys,
					path,
					content,
					getHeight: () => Math.max(3, tui.terminal.rows - 2),
					onClose: () => done(),
					onInsert: () => {
						done();
						this.insert(path);
					},
				});
			},
			{ overlay: true, overlayOptions: { width: "90%", maxHeight: "100%", anchor: "center" } },
		);
		if (generation === this.previewGeneration) this.closePreview = undefined;
	}

	private async selectModel(): Promise<void> {
		if (this.questionActive() || this.modelDialogOpen) return;
		this.modelDialogOpen = true;
		try {
			const models = this.ctx.modelRegistry.getAvailable();
			const labels = models.map((model) => `${model.provider}/${model.id}`);
			const selected = await this.ctx.ui.select("Model", labels, { signal: this.controller.signal });
			if (this.disposed || !selected) return;
			const model = models[labels.indexOf(selected)];
			if (model && !(await this.pi.setModel(model)))
				this.ctx.ui.notify("Model authentication is unavailable.", "warning");
		} finally {
			this.modelDialogOpen = false;
		}
	}

	refreshFiles(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (this.refreshTask) {
			this.pendingRefresh = true;
			return this.refreshTask;
		}
		this.refreshTask = this.runRefresh().finally(() => {
			this.refreshTask = undefined;
		});
		return this.refreshTask;
	}

	private async runRefresh(): Promise<void> {
		do {
			this.pendingRefresh = false;
			this.previewGeneration++;
			this.closePreview?.();
			this.pendingFiles.cancel();
			this.sidebar.refresh();
			const candidates = this.sidebar.candidates;
			this.sidebar.updating = true;
			this.sidebar.invalidate();
			this.tui.requestRender();
			const snapshot = await this.workspace.refresh(
				this.controller.signal,
				this.layout.visibility().explorer ? this.explorer.getExpandedDirectories() : [],
			);
			if (this.disposed) return;
			this.sidebar.git = snapshot?.summary;
			this.sidebar.branch = snapshot?.branch ?? "";
			const pending = await this.pendingFiles.reconcile(candidates, snapshot, this.controller.signal);
			if (this.disposed) return;
			this.sidebar.refresh();
			if (candidates !== this.sidebar.candidates) this.pendingRefresh = true;
			else if (pending) this.sidebar.publish(pending);
			this.sidebar.invalidate();
			this.tui.requestRender();
		} while (this.pendingRefresh && !this.disposed);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.previewGeneration++;
		this.closePreview?.();
		this.exitExplorer();
		this.unsubscribe();
		this.controller.abort();
		this.workspace.dispose();
		this.pendingFiles.dispose();
		this.sidebar.dispose();
		this.layout.dispose();
	}
}

export default function midnight(pi: ExtensionAPI): void {
	let panels: MidnightPanels | undefined;
	let starting = true;
	let title: SessionTitle | undefined;
	let projectSwitcher = new ProjectSwitcher();
	let compactTools = true;
	const toolRenderers = compactToolRenderers(() => compactTools);
	pi.registerToolRenderer(toolRenderers);
	pi.on("session_start", (_event, ctx) => {
		starting = true;
		projectSwitcher.dispose();
		projectSwitcher = new ProjectSwitcher();
		toolRenderers.dispose();
		panels?.dispose();
		title?.dispose();
		panels = undefined;
		title = undefined;
		if (ctx.mode !== "tui") return;
		applyDefaultTheme(pi, ctx);
		ctx.ui.setWidget("midnight-panels", (tui) => {
			panels = new MidnightPanels(
				pi,
				ctx,
				tui,
				() => projectSwitcher.active,
				() => starting || question.active || triage.active || evidence.active,
			);
			panels.updateEvidence({ ...new EvidenceLedger().summary(), unavailable: "Loading evidence" });
			return panels;
		});
	});
	const suite = registerSuite(pi, async (ctx) => {
		panels?.update(ctx, true);
		await panels?.refreshFiles();
		await evidence.check(ctx);
	});
	registerTokenSpeed(pi);
	const question = registerQuestion(
		pi,
		() => !triage.active && !evidence.active && (panels?.prepareQuestion() ?? true),
	);
	const triage = registerTriage(pi, {
		onUpdate: (status) => panels?.updateTriage(status),
		beforeDialog: () => !question.active && !evidence.active && (panels?.prepareQuestion() ?? true),
	});
	const evidence = registerEvidence(
		pi,
		(summary) => panels?.updateEvidence(summary),
		() => !question.active && !triage.active && (panels?.prepareQuestion() ?? true),
	);
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		starting = false;
		panels?.update(ctx, true);
		title = new SessionTitle(pi, ctx, (context) => panels?.update(context, true));
		void title.update(ctx);
	});
	pi.on("session_shutdown", () => {
		projectSwitcher.dispose();
		toolRenderers.dispose();
		panels?.dispose();
		title?.dispose();
		panels = undefined;
		title = undefined;
	});
	const update = (_event: unknown, ctx: ExtensionContext) => panels?.update(ctx, false);
	const refresh = (_event: unknown, ctx: ExtensionContext) => {
		panels?.update(ctx, true);
		void panels?.refreshFiles();
	};
	pi.on("agent_start", (event, ctx) => {
		title?.cancel();
		update(event, ctx);
	});
	pi.on("session_info_changed", (_event, ctx) => {
		title?.nameChanged(ctx);
		panels?.update(ctx, false);
	});
	pi.on("model_select", update);
	const refreshTitle = (event: unknown, ctx: ExtensionContext) => {
		refresh(event, ctx);
		void title?.update(ctx);
	};
	pi.on("agent_end", refreshTitle);
	pi.on("session_tree", refreshTitle);
	pi.on("session_compact", refreshTitle);
	pi.registerCommand("midnight", {
		description:
			"Midnight: status|doctor|config|context|rewind|checkpoints|browser; sidebar|explorer, project, compact, title, triage, evidence, refresh",
		handler: async (args, ctx) => {
			if (question.active || triage.active || evidence.active) {
				ctx.ui.notify("Finish or cancel the Midnight dialog before using /midnight commands.", "info");
				return;
			}
			if (await suite.command(args, ctx)) return;
			const [panel, mode] = args.trim().split(/\s+/);
			if (panel === "scaledown") {
				ctx.ui.notify(
					"ScaleDown was replaced by local-first chat-model triage. Old ScaleDown keys/consent are ignored. Use /midnight triage models, then model provider/id and on to authorize the selected helper.",
					"info",
				);
				return;
			}
			if (panel === "triage") {
				await triage.command(args.trim().replace(/^triage(?:\s+|$)/, ""), ctx);
				return;
			}
			if (panel === "evidence") {
				await evidence.command(args.trim().replace(/^evidence(?:\s+|$)/, ""), ctx);
				return;
			}
			if (panel === "project") {
				await projectSwitcher.run(args.trim().replace(/^project(?:\s+|$)/, "") || undefined, ctx);
				return;
			}
			if (panel === "compact" && (mode === "on" || mode === "off")) {
				compactTools = mode === "on";
				ctx.ui.setToolsExpanded(ctx.ui.getToolsExpanded());
				ctx.ui.notify(`Compact tool output ${compactTools ? "enabled" : "disabled"}.`, "info");
				return;
			}
			if (!panels) {
				ctx.ui.notify("Midnight panels are available in interactive TUI mode.", "info");
				return;
			}
			if (panel === "title" && (mode === "auto" || mode === "off")) {
				title?.setEnabled(mode === "auto", ctx);
				if (mode === "auto") void title?.update(ctx, true);
				ctx.ui.notify(`Automatic session titles ${mode === "auto" ? "enabled" : "disabled"}.`, "info");
			} else if (panel === "refresh") {
				panels.update(ctx, true);
				await panels.refreshFiles();
			} else if (panel === "explorer" && mode === "go") {
				await panels.browseFolder(args.trim().replace(/^explorer\s+go(?:\s+|$)/, "") || undefined);
			} else if (panel === "explorer" && mode === "parent") {
				await panels.browseFolder("..");
			} else if (panel === "explorer" && mode === "project") {
				await panels.browseFolder(ctx.cwd);
			} else if (
				(panel === "sidebar" || panel === "explorer") &&
				(mode === "auto" || mode === "always" || mode === "hidden")
			)
				panels.setMode(panel, mode);
			else if (panel === "sidebar" && !mode) panels.toggleSidebar();
			else if (panel === "explorer" && !mode) panels.toggleExplorer();
			else
				ctx.ui.notify(
					"/midnight status|doctor|config|context|rewind|checkpoints|browser; sidebar|explorer [auto|always|hidden], explorer go [path]|parent|project, project [path], compact on|off, title auto|off, triage model [provider/id]|models|on|off|status, evidence status|check|show [id], or refresh",
					"info",
				);
		},
	});
}
