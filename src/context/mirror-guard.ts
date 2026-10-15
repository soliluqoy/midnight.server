import { resolve } from "node:path";

export type MirrorToolIntent = "write" | "read" | "none";

const WRITE_INDICATOR =
	/(?:>>?|\btee\b|\bsed\s+(?:-\S+\s+)*-i\b|\bperl\s+(?:-\S+\s+)*-i\b|\btruncate\b|\brm\b|\bmv\b|\bcp\b|\bdd\b|write_text\s*\(|\.write\s*\(|\bwritelines\s*\(|\bopen\s*\([^()]*,\s*["'][wa])/;

export function classifyMirrorToolCall(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	mirrorPath: string,
): MirrorToolIntent {
	if (toolName === "edit" || toolName === "write") {
		const rawPath = typeof input.path === "string" ? input.path.replace(/^@/, "") : "";
		return rawPath && resolve(cwd, rawPath) === mirrorPath ? "write" : "none";
	}
	if (toolName !== "bash" || typeof input.command !== "string") return "none";
	const command = input.command;
	if (!command.includes(mirrorPath) && !command.includes("LIVE_CONTEXT.md")) return "none";
	return WRITE_INDICATOR.test(command) ? "write" : "read";
}
