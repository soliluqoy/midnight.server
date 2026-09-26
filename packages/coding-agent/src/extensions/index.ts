import type { InlineExtension } from "../core/extensions/types.ts";
import harnessExtension from "../harness/extension.ts";
import agentModeExtension from "./agent-mode.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "agent-mode", factory: agentModeExtension, hidden: true },
	{ name: "harness", factory: harnessExtension, hidden: true },
];
