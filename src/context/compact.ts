import { readFileSync } from "node:fs";

import { formatTokens } from "./settings.ts";

export const DEFAULT_COMPACT_PROMPT = `Compact your live context now.

Your next request is about {{current}} tokens{{budget}}. Your context is mirrored at \`{{mirror}}\`; edit that file, following the Editable context protocol, to remove what you no longer need.

Keep what you still need: the task and the user's latest requests, decisions and their reasons, open items, and exact values (ids, paths, numbers) you will use again. Drop what you no longer need: tool output you have already used, superseded drafts and intermediate steps. Prefer one scripted edit of the whole file over many small ones.

{{instructions}}

When the edit is saved, reply in one line: what you kept, and the new approximate size.`;

export interface CompactPromptValues {
	mirror: string;
	current: number;
	budget?: number;
	instructions?: string;
}

export function buildCompactPrompt(template: string, values: CompactPromptValues): string {
	const instructions = values.instructions?.trim() ? `Also: ${values.instructions.trim()}` : "";
	const replacements = new Map<string, string>([
		["mirror", values.mirror],
		["current", formatTokens(values.current)],
		["budget", values.budget === undefined ? "" : ` (budget ${formatTokens(values.budget)})`],
		["instructions", instructions],
	]);
	const withInstructions =
		instructions && !template.includes("{{instructions}}") ? `${template}\n\n{{instructions}}` : template;
	const emptySlot = "\u0000";
	return withInstructions
		.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
			name === "instructions" && !instructions ? emptySlot : (replacements.get(name) ?? match),
		)
		.replace(new RegExp(`\\n*${emptySlot}\\n*`, "g"), (slot) => (slot.includes("\n") ? "\n\n" : ""))
		.trim();
}

export function compactPromptFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env.PI_CLM_COMPACT_PROMPT?.trim();
	if (!raw || ["default", "none", "off"].includes(raw.toLowerCase())) return undefined;
	return raw;
}

export function loadCompactPrompt(path: string | undefined): string {
	if (!path) return DEFAULT_COMPACT_PROMPT;
	let text: string;
	try {
		text = readFileSync(path, "utf8").trim();
	} catch (error) {
		throw new Error(`compact prompt not loaded: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!text) throw new Error(`compact prompt is empty: ${path}`);
	return text;
}
