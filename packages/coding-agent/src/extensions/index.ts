import type { InlineExtension } from "../core/extensions/types.ts";
import harnessExtension from "../harness/extension.ts";
import { createSessionTitleExtension } from "../midnight/session-title.ts";
import agentModeExtension from "./agent-mode.ts";
import codemodeExtension from "./codemode/index.ts";
import mcpExtension from "./mcp/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "agent-mode", factory: agentModeExtension, hidden: true },
	{ name: "harness", factory: harnessExtension, hidden: true },
	{ name: "midnight-session-title", factory: createSessionTitleExtension(), hidden: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
