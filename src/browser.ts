import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const NAME = "chrome_devtools";
export function browserEndpoint(value: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error(
			"Browser connection requires a loopback HTTP debugging endpoint with no credentials, path, query or fragment.",
		);
	return url.href;
}
export function browserArguments(server: string, endpoint: string): string[] {
	return [
		server,
		`--browser-url=${browserEndpoint(endpoint)}`,
		"--no-usage-statistics",
		"--no-performance-crux",
		"--redact-network-headers",
	];
}
/** Browser access is integrated, not automatic. Never start Chrome or use a personal profile implicitly. */
export function registerBrowser(pi: ExtensionAPI) {
	let registered = false;
	let pending = false;
	let generation = 0;
	const stop = () => {
		generation++;
		if (registered) {
			pi.unregisterMcpServer(NAME);
			registered = false;
		}
	};
	pi.on("session_start", stop);
	pi.on("session_shutdown", stop);
	async function command(args: string, ctx: ExtensionCommandContext) {
		const [action = "status", endpoint, ...extra] = args.trim().split(/\s+/).filter(Boolean);
		if (action === "status") {
			ctx.ui.notify(
				`Midnight browser adapter: ${registered ? "registered (connection health not verified here)" : "off"}. Browser credentials, profiles and runtime configuration are not copied. A user mcp.json entry named ${NAME} takes precedence.`,
				"info",
			);
			return;
		}
		if (action === "disconnect" && !endpoint) {
			stop();
			ctx.ui.notify("Removed Midnight's browser registration. User-configured MCP servers were not changed.", "info");
			return;
		}
		if (action !== "connect" || !endpoint || extra.length) {
			ctx.ui.notify("/midnight browser status|disconnect|connect http://127.0.0.1:9222", "info");
			return;
		}
		if (pending || !ctx.hasUI || !ctx.isIdle() || ctx.hasPendingMessages()) {
			ctx.ui.notify("Browser connection needs an idle interactive session and explicit confirmation.", "warning");
			return;
		}
		pending = true;
		const epoch = generation;
		try {
			const url = browserEndpoint(endpoint);
			// Resolve the installed optional dependency without executing it or downloading anything here.
			const server = join(
				dirname(createRequire(import.meta.url).resolve("chrome-devtools-mcp/package.json")),
				"build",
				"src",
				"bin",
				"chrome-devtools-mcp.js",
			);
			const approved = await ctx.ui.confirm(
				"Connect Chrome debugging endpoint?",
				`Connect to ${url}. MCP tools can read and control that browser, including signed-in tabs. Use a dedicated debugging profile. Chrome must already be running; Midnight will not launch it. Usage telemetry and CrUX are disabled, header redaction is best effort. Existing user MCP configuration takes precedence.`,
			);
			if (!approved || epoch !== generation || !ctx.isIdle() || ctx.hasPendingMessages()) return;
			pi.registerMcpServer(NAME, {
				command: process.execPath,
				args: browserArguments(server, url),
				exposure: "deferred",
				description: "Explicitly connected Midnight Chrome DevTools adapter",
			});
			registered = true;
			ctx.ui.notify(
				"Browser MCP registration requested. Registration is not proof of a successful connection; inspect /mcp. Nothing was written to user configuration.",
				"info",
			);
		} catch (error) {
			ctx.ui.notify(
				`Browser unavailable: ${error instanceof Error ? error.message : String(error)}. Optional chrome-devtools-mcp dependency is required.`,
				"warning",
			);
		} finally {
			pending = false;
		}
	}
	return { command };
}
