import { relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	captureCheckpoint,
	loadCheckpoints,
	prepareRestore,
	pruneCheckpoints,
	type RestoreRecovery,
	readRestoreRecovery,
	repositoryRoot,
	restoreCheckpoint,
	type StoredCheckpoint,
	safePath,
} from "./core.ts";

import { importLegacyCheckpoint, legacyCheckpoints } from "./legacy.ts";
import { reviewRestore } from "./preview.ts";

const ENTRY = "midnight-checkpoint";
const REDO = "midnight-checkpoint-redo";
function branchRefs(ctx: ExtensionContext): string[] {
	return ctx.sessionManager.getBranch().flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== ENTRY || !entry.data || typeof entry.data !== "object")
			return [];
		const data = entry.data as { version?: unknown; ref?: unknown };
		return data.version === 1 && typeof data.ref === "string" ? [data.ref] : [];
	});
}
function contextRevision(ctx: ExtensionContext): number | null {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (
			entry.type !== "custom" ||
			entry.customType !== "live-context-state" ||
			!entry.data ||
			typeof entry.data !== "object"
		)
			continue;
		const revision = (entry.data as { revision?: unknown }).revision;
		if (typeof revision === "number" && Number.isSafeInteger(revision)) return revision;
	}
	return null;
}
export interface CheckpointController {
	command(args: string, ctx: ExtensionCommandContext): Promise<void>;
	status(): string;
	cancel(): void;
}
export function registerCheckpoints(
	pi: ExtensionAPI,
	owns: () => boolean,
	onRestore: (ctx: ExtensionContext) => void | Promise<void>,
): CheckpointController {
	let root: string | undefined;
	let controller = new AbortController();
	let generation = 0;
	let checkpoints: StoredCheckpoint[] = [];
	let dirty = false;
	let task: Promise<void> | undefined;
	let commandBusy = false;
	let warning: string | undefined;
	let scope = new Set<string>();
	let recovery: RestoreRecovery | null = null;
	const redo: { checkpoint: StoredCheckpoint; paths: string[] }[] = [];
	const record = (cp: StoredCheckpoint) => pi.appendEntry(ENTRY, { version: 1, ref: cp.ref });
	const recordRedo = () =>
		pi.appendEntry(REDO, { version: 1, steps: redo.map((step) => ({ ref: step.checkpoint.ref, paths: step.paths })) });
	async function loadRedo(project: string, ctx: ExtensionContext, signal: AbortSignal) {
		const entry = [...ctx.sessionManager.getEntries()]
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === REDO);
		if (!entry || entry.type !== "custom" || !entry.data || typeof entry.data !== "object") return [];
		const data = entry.data as { version?: unknown; steps?: unknown };
		if (data.version !== 1 || !Array.isArray(data.steps) || data.steps.length > 50) return [];
		const steps: { ref: string; paths: string[] }[] = [];
		for (const step of data.steps) {
			if (!step || typeof step !== "object") throw new Error("Invalid saved redo state.");
			const value = step as { ref?: unknown; paths?: unknown };
			if (
				typeof value.ref !== "string" ||
				!Array.isArray(value.paths) ||
				value.paths.length > 10000 ||
				!value.paths.every((p) => typeof p === "string" && safePath(p))
			)
				throw new Error("Invalid saved redo paths.");
			steps.push({ ref: value.ref, paths: value.paths });
		}
		const loaded = await loadCheckpoints(
			project,
			steps.map((step) => step.ref),
			signal,
		);
		return steps.map((step) => {
			const checkpoint = loaded.get(step.ref);
			if (!checkpoint || checkpoint instanceof Error) throw checkpoint ?? new Error("Saved redo is unavailable.");
			return { checkpoint, paths: step.paths };
		});
	}
	function cancel() {
		generation++;
		controller.abort();
		controller = new AbortController();
		dirty = false;
		task = undefined;
	}
	async function load(ctx: ExtensionContext) {
		cancel();
		root = undefined;
		checkpoints = [];
		scope = new Set();
		redo.length = 0;
		recovery = null;
		warning = undefined;
		if (!owns()) return;
		const epoch = generation;
		const signal = controller.signal;
		try {
			const project = await repositoryRoot(ctx.cwd, signal);
			const refs = branchRefs(ctx);
			const loaded = await loadCheckpoints(project, refs, signal);
			if (epoch !== generation) return;
			const branch: StoredCheckpoint[] = [];
			for (const ref of refs) {
				const cp = loaded.get(ref);
				if (!cp || cp instanceof Error)
					warning = "Some recorded checkpoints are unavailable or pruned; they are not treated as clean.";
				else branch.push(cp);
			}
			const savedRedo = await loadRedo(project, ctx, signal);
			const pending = await readRestoreRecovery(project);
			if (epoch !== generation) return;
			root = project;
			checkpoints = branch;
			redo.push(...savedRedo);
			recovery = pending;
			scope = new Set(branch.flatMap((cp) => cp.scope));
			if (!pending) await capture(ctx, "resume");
			else
				warning =
					"An incomplete restore has a recovery journal. Use /midnight checkpoints recover; nothing was restored automatically.";
		} catch (error) {
			if (epoch === generation) warning = error instanceof Error ? error.message : String(error);
		}
	}
	async function capture(ctx: ExtensionContext, trigger: "resume" | "turn" | "manual") {
		if (!root || !owns()) return;
		const epoch = generation;
		const signal = controller.signal;
		const project = root;
		const previous = checkpoints.at(-1);
		const cp = await captureCheckpoint(project, {
			sessionId: ctx.sessionManager.getSessionId(),
			entryId: ctx.sessionManager.getLeafId(),
			contextRevision: contextRevision(ctx),
			trigger,
			scope: [...scope],
			previous,
			deduplicate: true,
			signal,
		});
		if (epoch !== generation || signal.aborted) return;
		scope = new Set(cp.scope);
		if (cp.ref === previous?.ref) return;
		checkpoints.push(cp);
		record(cp);
		warning = undefined;
		await pruneCheckpoints(project, ctx.sessionManager.getSessionId(), 50, signal);
	}
	const refresh = async (_event: unknown, ctx: ExtensionContext) => {
		const current = load(ctx);
		task = current;
		await current;
		if (task === current) task = undefined;
	};
	pi.on("session_start", refresh);
	pi.on("session_tree", refresh);
	pi.on("session_shutdown", () => {
		cancel();
		root = undefined;
		checkpoints = [];
		redo.length = 0;
	});
	pi.on("tool_result", (event, ctx) => {
		if (!owns() || !root) return;
		if (["write", "edit", "bash", "powershell", "codemode"].includes(event.toolName)) dirty = true;
		if (!event.isError && (event.toolName === "write" || event.toolName === "edit")) {
			const input = event.input as { path?: unknown };
			if (typeof input.path === "string") {
				const path = relative(root, resolve(ctx.cwd, input.path)).split("\\").join("/");
				if (safePath(path)) scope.add(path);
			}
		}
	});
	pi.on("tool_execution_end", (event) => {
		if (owns() && ["write", "edit", "bash", "powershell", "codemode"].includes(event.toolName)) dirty = true;
	});
	pi.on("turn_end", async (_event, ctx) => {
		if (!dirty || !owns() || task || commandBusy || recovery) return;
		dirty = false;
		const epoch = generation;
		const current = capture(ctx, "turn").catch((error) => {
			if (epoch === generation) warning = error instanceof Error ? error.message : String(error);
		});
		task = current;
		await current;
		if (task === current) task = undefined;
	});
	async function command(args: string, ctx: ExtensionCommandContext) {
		if (!owns()) {
			ctx.ui.notify(
				"Native checkpoints are inactive; inspect /midnight status. Remove external pi-rewind and reload to use native checkpoints.",
				"warning",
			);
			return;
		}
		if (!ctx.isIdle() || ctx.hasPendingMessages() || task || commandBusy) {
			ctx.ui.notify("Wait for the current run, checkpoint operation, and queued messages to finish.", "warning");
			return;
		}
		if (!root) {
			ctx.ui.notify(warning ?? "Checkpoints need an available Git worktree.", "warning");
			return;
		}
		const action = args.trim();
		if (action === "status") {
			ctx.ui.notify(status(), "info");
			return;
		}
		commandBusy = true;
		const epoch = generation;
		const project = root;
		try {
			recovery = await readRestoreRecovery(project);
			if (action === "legacy" || action === "import") {
				const legacy = await legacyCheckpoints(project, ctx.sessionManager.getSessionId());
				if (action === "legacy" || !legacy.available.length || !ctx.hasUI) {
					ctx.ui.notify(
						`${legacy.available.length} readable legacy checkpoints in this session; ${legacy.unavailable} unavailable refs (possibly other sessions). /midnight checkpoints import explicitly imports metadata. Original refs are never pruned.`,
						"info",
					);
					return;
				}
				const choices = legacy.available.map(
					(cp) => `${cp.ref} · ${cp.snapshot.scope.length} pending paths · ${cp.snapshot.excluded.length} excluded`,
				);
				const selected = await ctx.ui.select("Import legacy checkpoint metadata", choices);
				if (!selected || epoch !== generation) return;
				const source = legacy.available[choices.indexOf(selected)];
				const confirmed = await ctx.ui.confirm(
					"Import legacy snapshot?",
					"Only native Git refs and session metadata will be added. No files, index or HEAD will change. Legacy snapshots represent pending state, not exact authorship. Conversation mapping is unavailable; imported snapshots support files-only restores. Original refs are retained.",
				);
				if (!confirmed || epoch !== generation || !ctx.isIdle() || ctx.hasPendingMessages()) return;
				const imported = await importLegacyCheckpoint(project, source.ref, ctx.sessionManager.getSessionId());
				if (epoch !== generation) return;
				checkpoints.push(imported);
				for (const path of imported.scope) scope.add(path);
				record(imported);
				ctx.ui.notify("Legacy checkpoint metadata imported. Files and Git HEAD were not changed.", "info");
				return;
			}
			if (action === "capture") {
				if (recovery)
					throw new Error("Resolve the incomplete restore with /midnight checkpoints recover before capturing.");
				await capture(ctx, "manual");
				ctx.ui.notify("Checkpoint captured (unchanged snapshots are deduplicated).", "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("Restore requires an interactive confirmation dialog. No files were changed.", "warning");
				return;
			}
			if (action && action !== "redo" && action !== "recover") {
				ctx.ui.notify("Usage: /midnight rewind [status|capture|redo|recover|legacy|import]", "info");
				return;
			}
			if (recovery && action !== "recover")
				throw new Error("A failure journal needs /midnight checkpoints recover; no ordinary restore is allowed yet.");
			const available =
				action === "recover"
					? recovery
						? [recovery.backup]
						: []
					: action === "redo"
						? redo.slice(-1).map((step) => step.checkpoint)
						: checkpoints.filter((cp) => cp.trigger !== "before-restore");
			if (!available.length) {
				ctx.ui.notify("No available checkpoints on this branch.", "info");
				return;
			}
			const labels = [...available]
				.reverse()
				.map(
					(cp) =>
						`${cp.id.slice(0, 8)} · ${new Date(cp.timestamp).toLocaleString()} · ${cp.trigger} · ${cp.excluded.length} excluded`,
				);
			const chosen =
				action === "redo" || action === "recover"
					? labels[0]
					: await ctx.ui.select("Midnight checkpoints — current pending state, not exact authorship", labels);
			if (!chosen || epoch !== generation) return;
			const target = [...available].reverse()[labels.indexOf(chosen)];
			const choice =
				action === "recover"
					? "Files only"
					: await ctx.ui.select("Restore what?", ["Files and conversation", "Files only", "Conversation only"]);
			if (!choice || epoch !== generation) return;
			if (
				choice !== "Files only" &&
				(!target.entryId || !ctx.sessionManager.getEntries().some((entry) => entry.id === target.entryId))
			)
				throw new Error("The checkpoint's conversation entry is unavailable. Choose files only.");
			if (choice !== "Conversation only") {
				const paths =
					action === "recover" ? (recovery?.paths ?? []) : action === "redo" ? (redo.at(-1)?.paths ?? []) : [...scope];
				const plan = await prepareRestore(project, target, paths);
				if (!(await reviewRestore(ctx, plan)) || epoch !== generation) return;
				const confirmed = await ctx.ui.confirm(
					"Confirm scoped file restore",
					`${plan.changes.length} reviewed paths change; ${target.excluded.length} snapshot paths excluded. HEAD stays unchanged.\n\nA recovery checkpoint is mandatory. Other paths are preserved.`,
				);
				if (!confirmed || epoch !== generation || !ctx.isIdle() || ctx.hasPendingMessages()) return;
				const backup = await restoreCheckpoint(project, plan, {
					sessionId: ctx.sessionManager.getSessionId(),
					entryId: ctx.sessionManager.getLeafId(),
					contextRevision: contextRevision(ctx),
					scope: paths,
					signal: controller.signal,
					recovery: action === "recover" ? recovery?.fingerprint : undefined,
				});
				if (epoch !== generation) return;
				record(backup);
				if (action === "redo") redo.pop();
				else {
					redo.push({ checkpoint: backup, paths });
					if (redo.length > 50) redo.shift();
				}
				recovery = null;
				recordRedo();
				await onRestore(ctx);
			}
			if (choice !== "Files only" && target.entryId) {
				const result = await ctx.navigateTree(target.entryId, { summarize: false });
				if (result.cancelled) {
					ctx.ui.notify(
						"Conversation navigation was cancelled. Any confirmed file restore already completed; use the recovery checkpoint if needed.",
						"warning",
					);
					return;
				}
			}
			ctx.ui.notify("Restore completed. Git HEAD was not changed.", "info");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		} finally {
			commandBusy = false;
		}
	}
	function status() {
		return `Checkpoints: ${root ? checkpoints.length : "unavailable"} · ${scope.size} observed session paths · ${redo.length} redo steps${warning ? `\n${warning}` : ""}\nSnapshots are local Git objects; exclusions are not a secrecy guarantee. Restore scope is observed pending state, not exact authorship.`;
	}
	pi.registerCommand("midnight-rewind", {
		description: "Native checkpoint browser; status, capture, redo, recover",
		handler: command,
	});
	return { command, status, cancel };
}
