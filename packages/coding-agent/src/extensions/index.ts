import type { InlineExtension } from "../core/extensions/types.ts";
import harnessExtension from "../harness/extension.ts";
import { createSessionTitleExtension } from "../midnight/session-title.ts";
import agentModeExtension from "./agent-mode.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "agent-mode", factory: agentModeExtension, hidden: true },
	{ name: "harness", factory: harnessExtension, hidden: true },
	{ name: "midnight-session-title", factory: createSessionTitleExtension(), hidden: true },
];
