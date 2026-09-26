import type { ExtensionAPI } from "../core/extensions/types.ts";
import { getMidnightStatus } from "../midnight/status.ts";

/** Tools that cannot change files or run commands. Extension tools are excluded: their side effects are unknown. */
export const PLAN_MODE_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "delegate_local", "task"];

const PLAN_MODE_SECTION = [
	"Plan mode is on. You can read and search the workspace but cannot edit files or run commands.",
	"Investigate what you need, then reply with a concrete, numbered plan: the files to change, what to change in each, and how to verify it.",
	"Do not claim to have made changes. The user switches to build mode to carry the plan out.",
].join("\n");

/**
 * Plan/build switch. The UI flips the mode in the shared midnight status store; this
 * extension applies it at the start of the next prompt by swapping the active tool set
 * for a read-only one and adding an `agent_mode` prompt section, and restores the
 * previous tool set when switching back. A `tool_call` guard also blocks non-read-only
 * tools immediately, so switching to plan mode mid-run takes effect on the next call.
 */
export default function agentModeExtension(pi: ExtensionAPI): void {
	let buildTools: string[] | undefined;

	pi.on("before_agent_start", (event) => {
		const plan = getMidnightStatus().agentMode === "plan";
		if (plan) {
			if (buildTools === undefined) buildTools = pi.getActiveTools();
			const available = new Set(pi.getAllTools().map((tool) => tool.name));
			pi.setActiveTools(PLAN_MODE_TOOLS.filter((name) => available.has(name)));
			event.systemPromptOptions.sections.agent_mode = PLAN_MODE_SECTION;
			return;
		}
		if (buildTools !== undefined) {
			pi.setActiveTools(buildTools);
			buildTools = undefined;
		}
		delete event.systemPromptOptions.sections.agent_mode;
	});

	pi.on("tool_call", (event) => {
		if (getMidnightStatus().agentMode !== "plan" || PLAN_MODE_TOOLS.includes(event.toolName)) return;
		return {
			block: true,
			reason: `${event.toolName} is disabled in plan mode. Describe the change in your plan instead; the user switches to build mode to apply it.`,
		};
	});
}
