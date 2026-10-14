import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { registerBrowser } from "../browser.ts";
import { registerCheckpoints } from "../checkpoints/index.ts";
import { registerNativeContext } from "../context/native.ts";
import { externalContextPresent, registerAvailableAliases, type ServiceOwner } from "./ownership.ts";

const SETTINGS = "midnight-suite-settings";
export interface SuiteSettings {
	version: 1;
	context: boolean;
	checkpoints: boolean;
}
export function suiteSettings(
	branch: readonly { type: string; customType?: string; data?: unknown }[],
	env: NodeJS.ProcessEnv = process.env,
): SuiteSettings {
	const enabled = (name: string) => !["0", "false", "off", "no"].includes(env[name]?.trim().toLowerCase() ?? "");
	let settings: SuiteSettings = {
		version: 1,
		context: enabled("MIDNIGHT_CONTEXT"),
		checkpoints: enabled("MIDNIGHT_CHECKPOINTS"),
	};
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== SETTINGS || !entry.data || typeof entry.data !== "object")
			continue;
		const data = entry.data as Partial<SuiteSettings>;
		if (data.version === 1 && typeof data.context === "boolean" && typeof data.checkpoints === "boolean")
			settings = data as SuiteSettings;
	}
	return settings;
}
export function registerSuite(pi: ExtensionAPI, onRestore: (ctx: ExtensionContext) => void | Promise<void>) {
	let contextOwner: ServiceOwner = "pending";
	let checkpointOwner: ServiceOwner = "pending";
	let contextProblem: string | undefined;
	let preferences: SuiteSettings = { version: 1, context: true, checkpoints: true };
	const aliases = new Set<string>();
	let commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	// This runs before either service's startup handler. Public runtime APIs are now bound.
	const ownership = (_event: unknown, ctx: ExtensionContext) => {
		preferences = suiteSettings(ctx.sessionManager.getBranch());
		try {
			const names = pi
				.getCommands()
				.map((command) => command.name)
				.filter((name) => !aliases.has(name));
			const tools = pi.getAllTools().map((tool) => tool.name);
			contextOwner = contextProblem
				? "unavailable"
				: !preferences.context
					? "disabled"
					: externalContextPresent(names, tools)
						? "external"
						: "native";
			checkpointOwner = !preferences.checkpoints ? "disabled" : names.includes("rewind") ? "external" : "native";
			if (contextOwner === "external" || checkpointOwner === "external")
				ctx.ui.notify(
					"Midnight detected external CLM/rewind ownership. Native overlapping engines are paused. Remove external packages and /reload to migrate; nothing was uninstalled or rewritten.",
					"warning",
				);
		} catch (error) {
			contextOwner = "unavailable";
			checkpointOwner = "unavailable";
			contextProblem = `Runtime inspection failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	};
	pi.on("session_start", ownership);
	pi.on("session_tree", ownership);
	try {
		commands = registerNativeContext(pi, () => contextOwner === "native");
	} catch (error) {
		contextProblem = error instanceof Error ? error.message : String(error);
	}
	const checkpoints = registerCheckpoints(pi, () => checkpointOwner === "native", onRestore);
	const browser = registerBrowser(pi);
	pi.on("session_start", () => {
		const requested: Record<string, string> = {};
		if (contextOwner === "native") {
			requested.clm = "midnight-context";
			requested["clm-compact"] = "midnight-context-compact";
		}
		if (checkpointOwner === "native") {
			commands.set("midnight-rewind", { description: "Native Midnight rewind", handler: checkpoints.command });
			requested.rewind = "midnight-rewind";
		}
		for (const alias of registerAvailableAliases(pi, commands, requested)) aliases.add(alias);
	});
	function status() {
		return `Midnight native suite\nContext: ${contextOwner}${contextProblem ? ` — ${contextProblem}` : ""}\nCheckpoints: ${checkpointOwner}\n${checkpoints.status()}\nCore services need no separate pi-clm/pi-rewind install. ScaleDown and browser connections remain explicit opt-ins.`;
	}
	async function command(args: string, ctx: ExtensionCommandContext) {
		const [action, ...rest] = args.trim().split(/\s+/);
		if (action === "status" || action === "doctor") {
			ctx.ui.notify(
				status() +
					(action === "doctor"
						? "\nCompatibility target: Pi/TUI 1.2.0, Node 22.19+, Git on PATH. Inspect /midnight context status for effective context settings. No network checks were made."
						: ""),
				"info",
			);
			return true;
		}
		if (action === "context") {
			const sub = rest.join(" ");
			const name = sub === "compact" || sub.startsWith("compact ") ? "midnight-context-compact" : "midnight-context";
			const handler = commands.get(name);
			if (!handler) ctx.ui.notify(contextProblem ?? "Native context unavailable.", "warning");
			else await handler.handler(name.endsWith("-compact") ? sub.replace(/^compact\s*/, "") : sub, ctx);
			return true;
		}
		if (action === "browser") {
			await browser.command(rest.join(" "), ctx);
			return true;
		}
		if (action === "rewind" || action === "checkpoints") {
			await checkpoints.command(rest.join(" "), ctx);
			return true;
		}
		if (action === "config") {
			const [key, value] = rest;
			if (!key) {
				ctx.ui.notify(
					`Session service settings: context=${preferences.context ? "on" : "off"}, checkpoints=${preferences.checkpoints ? "on" : "off"}.\n/midnight config context|checkpoints on|off (saved on this branch; reload or switch session/branch to activate).\nContext policy: /midnight context config. Existing panel/title/ScaleDown controls are unchanged.`,
					"info",
				);
				return true;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Finish the current run and queued messages before changing service settings.", "warning");
				return true;
			}
			if ((key !== "context" && key !== "checkpoints") || (value !== "on" && value !== "off") || rest.length !== 2) {
				ctx.ui.notify("Usage: /midnight config context|checkpoints on|off", "warning");
				return true;
			}
			preferences = { ...preferences, [key]: value === "on" };
			pi.appendEntry(SETTINGS, preferences);
			ctx.ui.notify(
				"Saved branch-local service settings. Reload or switch session/branch to activate; current ownership was not changed now.",
				"info",
			);
			return true;
		}
		return false;
	}
	return { command, status, checkpoints };
}
