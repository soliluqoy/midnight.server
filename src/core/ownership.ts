import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export type ServiceOwner = "pending" | "native" | "external" | "disabled" | "unavailable";
type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
type Handler = (...args: unknown[]) => unknown;

export function externalContextPresent(commands: readonly string[], tools: readonly string[]): boolean {
	return (
		commands.some((name) => name === "clm" || name === "live-context") ||
		tools.some((name) => name === "live_context_annotate" || name === "live_context_recall")
	);
}

export function ownedAPI(pi: ExtensionAPI, owns: () => boolean, commands: Map<string, Command>): ExtensionAPI {
	return new Proxy(pi, {
		get(target, key) {
			if (key === "on") {
				const register = target.on as unknown as (event: string, handler: Handler) => () => void;
				return (event: string, handler: Handler) =>
					register(event, (...args) => {
						if (event === "session_shutdown" || owns()) return handler(...args);
						return undefined;
					});
			}
			if (key === "registerCommand") {
				return (name: string, command: Command) => {
					const guarded = {
						...command,
						handler: async (args: string, ctx: ExtensionCommandContext) => {
							if (!owns()) {
								ctx.ui.notify(
									"Native Midnight service is inactive; inspect /midnight status. External extensions keep ownership until removed and reloaded.",
									"warning",
								);
								return;
							}
							await command.handler(args, ctx);
						},
					};
					commands.set(name, guarded);
					target.registerCommand(name, guarded);
				};
			}
			if (key === "registerTool") {
				return (tool: ToolDefinition) =>
					target.registerTool({
						...tool,
						async execute(...args) {
							if (!owns()) throw new Error("Native Midnight context is inactive; inspect /midnight status.");
							return tool.execute(...args);
						},
					});
			}
			return Reflect.get(target, key);
		},
	});
}

export function registerAvailableAliases(
	pi: ExtensionAPI,
	commands: Map<string, Command>,
	aliases: Readonly<Record<string, string>>,
): Set<string> {
	const registered = new Set<string>();
	const occupied = new Set(pi.getCommands().map((command) => command.name));
	for (const [alias, canonical] of Object.entries(aliases)) {
		const command = commands.get(canonical);
		if (!occupied.has(alias) && command) {
			pi.registerCommand(alias, command);
			registered.add(alias);
		}
	}
	return registered;
}
