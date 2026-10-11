import path from "node:path";
import type { GitSnapshot } from "../git-status.ts";
import { readGitSnapshot } from "../git-status.ts";
import { cleanText, object } from "./workspace.ts";

function record(value: unknown): Record<string, unknown> {
	try {
		return object(value);
	} catch {
		return {};
	}
}

function label(value: unknown): string | undefined {
	return typeof value === "string"
		? cleanText(value).replace(/\s+/g, " ").trim().slice(0, 100) || undefined
		: undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function claudeDirectory(value: unknown): string | undefined {
	const data = record(value);
	const cwd = record(data.workspace).current_dir ?? data.cwd;
	return typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : undefined;
}

/** Only display fields supplied by the client; no transcript scans or guessed timing. */
export function formatClaudeStatus(value: unknown, git?: GitSnapshot): string {
	const data = record(value);
	const cwd = claudeDirectory(data);
	const model = record(data.model);
	const context = record(data.context_window);
	const cost = record(data.cost);
	const title = label(data.session_name);
	const identity = [
		"Midnight",
		cwd ? label(path.basename(cwd) || cwd) : undefined,
		git?.branch ? label(git.branch) : undefined,
		label(model.display_name) ?? label(model.id),
		title,
	].filter(Boolean);
	const details: string[] = [];
	if (git?.summary) {
		const { staged, unstaged, untracked, conflicted, ahead, behind } = git.summary;
		details.push(`Git ${staged} staged / ${unstaged} modified / ${untracked} untracked / ${conflicted} conflicts`);
		if (ahead || behind) details.push(`ahead ${ahead ?? 0} / behind ${behind ?? 0}`);
	} else details.push("Git unavailable");
	const used = number(context.used_percentage);
	if (used !== undefined) details.push(`ctx ${Math.min(100, used).toFixed(1)}%`);
	const input = number(context.total_input_tokens);
	const output = number(context.total_output_tokens);
	if (input !== undefined) details.push(`context in ${input.toLocaleString("en-US")}`);
	if (output !== undefined) details.push(`last out ${output.toLocaleString("en-US")}`);
	const dollars = number(cost.total_cost_usd);
	if (dollars !== undefined) details.push(`est $${dollars.toFixed(2)}`);
	return `${identity.join(" | ")}\n${details.join(" | ")}`;
}

export async function claudeStatusLine(value: unknown): Promise<string> {
	const cwd = claudeDirectory(value);
	const controller = new AbortController();
	const stop = () => controller.abort();
	const timeout = setTimeout(stop, 1500);
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		return formatClaudeStatus(value, cwd ? await readGitSnapshot(cwd, "", controller.signal) : undefined);
	} finally {
		clearTimeout(timeout);
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
	}
}
