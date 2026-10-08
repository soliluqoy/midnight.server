import { constants } from "node:fs";
import { access, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { relative } from "node:path";
import { type ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { resolveExplorerFolder } from "./explorer-location.ts";

export const OPEN_PROJECT = "Open this folder as working project…";
export const SWITCH_PROJECT = "Switch working project…";

export interface PreparedProjectSession {
	path: string;
	discard(): Promise<void>;
}

/** Check only when asked. Do not run a shell, look for Git, or list folder contents. */
export async function validateProjectFolder(input: string, cwd: string): Promise<string> {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Block control characters in folder paths.
	if (!input.trim() || /[\x00-\x1f\x7f]/.test(input))
		throw new Error("Enter a folder path without control characters.");
	const target = await realpath(resolveExplorerFolder(input, cwd));
	if (!(await stat(target)).isDirectory()) throw new Error("The destination is not a directory.");
	await access(target, constants.R_OK | constants.X_OK);
	return target;
}

/**
 * Pi 1.0.4 can switchSession across folders, but newSession cannot set cwd.
 * Let SessionManager make the path and header. Save the header ourselves because
 * create() waits for a conversation before saving. Do not copy history, guess the
 * file format, or change Pi's private fields.
 */
export async function prepareProjectSession(
	cwd: string,
	source: ExtensionCommandContext["sessionManager"],
): Promise<PreparedProjectSession> {
	// Check where Pi saves sessions without reading history or making
	// an extra default folder when a custom folder is in use.
	const storage = SessionManager.create(source.getCwd(), source.getSessionDir());
	const customDir = storage.usesDefaultSessionDir() ? undefined : storage.getSessionDir();
	const manager = SessionManager.create(cwd, customDir, { parentSession: source.getSessionFile() });
	const path = manager.getSessionFile();
	const header = manager.getHeader();
	if (!path || !header) throw new Error("Pi could not allocate a destination session.");
	const contents = `${JSON.stringify(header)}\n`;
	const file = await open(path, "wx", 0o600);
	try {
		await file.writeFile(contents);
	} catch (error) {
		await file.close();
		await unlink(path);
		throw error;
	} finally {
		await file.close();
	}
	return {
		path,
		async discard() {
			try {
				// A cancel hook may have changed this file. Do not delete those changes.
				if ((await stat(path)).size === Buffer.byteLength(contents) && (await readFile(path, "utf8")) === contents)
					await unlink(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		},
	};
}

interface ProjectSwitchIO {
	validate: typeof validateProjectFolder;
	canonical: typeof realpath;
	prepare: typeof prepareProjectSession;
}

/** Switch one project at a time. After cancel or reload, ignore late work from the old session. */
export class ProjectSwitcher {
	private readonly controller = new AbortController();
	private busy = false;
	private readonly io: ProjectSwitchIO;

	constructor(io: Partial<ProjectSwitchIO> = {}) {
		this.io = { validate: validateProjectFolder, canonical: realpath, prepare: prepareProjectSession, ...io };
	}

	get active(): boolean {
		return this.busy;
	}

	dispose(): void {
		this.controller.abort();
	}

	async run(input: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
		if (this.busy || this.controller.signal.aborted) return;
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Project switching requires interactive TUI mode.", "info");
			return;
		}
		const ready = () => {
			if (this.controller.signal.aborted) return false;
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Finish or stop active work and clear queued messages before switching projects.", "warning");
				return false;
			}
			return true;
		};
		if (!ready()) return;
		if (!ctx.sessionManager.getSessionFile()) {
			ctx.ui.notify("Project switching needs persisted sessions; it is unavailable with --no-session.", "warning");
			return;
		}
		this.busy = true;
		let prepared: PreparedProjectSession | undefined;
		let handedToPi = false;
		try {
			const options = { signal: this.controller.signal };
			const value =
				input ?? (await ctx.ui.input("Switch working project", "Folder path (relative to current project)", options));
			if (!value?.trim() || !ready()) return;
			const target = await this.io.validate(value, ctx.cwd);
			if (!ready()) return;
			const current = await this.io.canonical(ctx.cwd);
			if (!ready()) return;
			if (relative(current, target) === "") {
				ctx.ui.notify("That folder is already the working project.", "info");
				return;
			}
			const draft = ctx.ui.getEditorText();
			const confirmed = await ctx.ui.confirm(
				"Switch working project?",
				stripTerminalSequences(
					`From: ${ctx.cwd}\nTo: ${target}\n\nStart a fresh session; the current conversation stays in the old project.\nPi will reload project instructions, settings, tools, and trust.\n${draft ? "Your unsent draft will move unchanged. Review any relative paths before sending." : "No conversation or model-generated handoff is copied."}`,
				),
				options,
			);
			if (!confirmed || !ready()) return;
			prepared = await this.io.prepare(target, ctx.sessionManager);
			if (!ready()) return;
			if (ctx.ui.getEditorText() !== draft) {
				ctx.ui.notify("The draft changed while switching. Try again; nothing was switched.", "warning");
				return;
			}
			// Pi handles cleanup, trust, and errors from here. After the switch,
			// do not use the old context or delete the new session's file.
			handedToPi = true;
			const result = await ctx.switchSession(prepared.path, {
				withSession: async (fresh) => {
					fresh.ui.setEditorText(draft);
					fresh.ui.notify(stripTerminalSequences(`Working project: ${fresh.cwd}`), "info");
				},
			});
			if (result.cancelled) handedToPi = false;
		} catch (error) {
			if (handedToPi) throw error;
			if (!this.controller.signal.aborted)
				ctx.ui.notify(
					stripTerminalSequences(`Cannot switch project: ${error instanceof Error ? error.message : error}`),
					"warning",
				);
		} finally {
			try {
				if (prepared && !handedToPi) await prepared.discard();
			} finally {
				this.busy = false;
			}
		}
	}
}
