import { fileURLToPath } from "node:url";
import type { ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { ownedAPI } from "../core/ownership.ts";
import { budgetPolicyFromEnv, estimateFactorFromEnv } from "./budget.ts";
import { compactPromptFromEnv } from "./compact.ts";
import liveContextExtension, { type LiveContextExtensionOptions } from "./index.ts";
import { observationCapFromEnv } from "./observation.ts";
import { overflowGuardFromEnv } from "./overflow.ts";
import { steeringPathFromEnv } from "./steering.ts";

export function nativeContextOptions(env: NodeJS.ProcessEnv = process.env): LiveContextExtensionOptions {
	const compaction = env.PI_CLM_NATIVE_COMPACTION?.trim();
	if (compaction && !["auto", "off", "on"].includes(compaction))
		throw new Error("PI_CLM_NATIVE_COMPACTION must be auto, off or on.");
	const flag = (name: string) => ["1", "true", "on", "yes"].includes(env[name]?.trim().toLowerCase() ?? "");
	return {
		editingMode: "clm",
		commandName: "midnight-context",
		budget: { contextBudget: 150000, ...budgetPolicyFromEnv(env) },
		observationCap: observationCapFromEnv(env),
		overflow: overflowGuardFromEnv(env),
		nativeCompaction: compaction as "auto" | "off" | "on" | undefined,
		steeringPath:
			env.PI_CLM_STEERING !== undefined
				? steeringPathFromEnv(env)
				: fileURLToPath(new URL("../../steering/house-brief.md", import.meta.url)),
		estimateFactor: estimateFactorFromEnv(env),
		oneToolPerTurn: flag("PI_CLM_ONE_TOOL_PER_TURN"),
		sizeTrailer: flag("PI_CLM_SIZE_TRAILER"),
		compactPromptPath: compactPromptFromEnv(env),
	};
}
export function registerNativeContext(
	pi: ExtensionAPI,
	owns: () => boolean,
): Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">> {
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	liveContextExtension(ownedAPI(pi, owns, commands), nativeContextOptions());
	return commands;
}
