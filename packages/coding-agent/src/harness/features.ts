import type { Api, Model } from "@earendil-works/pi-ai";
import { LOCAL_PROVIDER_ID } from "../midnight/pins.ts";

/**
 * Harness features and the model classes that pick their defaults.
 *
 * Every feature can be switched in `harness.json` (`features: { name: false }`) and, for
 * measurement, with `MIDNIGHT_SERVER_HARNESS_FEATURES=-contextPack,+contract`. The eval
 * (`scripts/harness-eval.mjs`) builds ablation variants from that variable.
 */
export const FEATURE_NAMES = [
	/** The `task` contract tool and its acceptance-criteria reminder. */
	"contract",
	/** Batched observation masking of old tool results. */
	"masking",
	/** Repo map, ranked files and environment facts in the first request of each prompt. */
	"contextPack",
	/** Reject edits that break a file's syntax, restoring the previous content. */
	"parseGate",
	/** Indentation-tolerant edit matching and closest-match hints when oldText is not found. */
	"editRepair",
	/** "Did you mean" suggestions when a path does not exist. */
	"pathHints",
	/** Tell the model when it repeats the same call or the same failing command. */
	"loopGuard",
	/** Checks after edits during the run, not only when the model says it is done. */
	"inRunChecks",
	/** Snapshot passing states and restore the last one after repeated check failures. */
	"checkpoints",
	/** The `lookup` tool: definitions, references and outlines through LSP or syntax outlines. */
	"lookup",
	/** New language-server errors reported with each edit result. */
	"diagnostics",
	/** Ask a stronger model for advice when a fast model is stuck. */
	"escalation",
	/** Core-tools-only, capped output and greedy decoding for the embedded local model. */
	"localProfile",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/**
 * How the harness treats a model.
 * - `local`: the embedded MiniCPM model: small window, slow prompt processing.
 * - `fast`: cheap cloud models (list input price under $2 per million tokens, or unknown).
 *   They gain the most from work moved into code, and they can escalate.
 * - `frontier`: expensive strong models. Same deterministic help, no escalation.
 */
export type ModelClass = "local" | "fast" | "frontier";

/** Input price in USD per million tokens at and above which a model counts as frontier. */
export const FRONTIER_INPUT_PRICE = 2;

export function classifyModel(model: Pick<Model<Api>, "provider" | "cost"> | undefined): ModelClass {
	if (!model) return "fast";
	if (model.provider === LOCAL_PROVIDER_ID) return "local";
	return (model.cost?.input ?? 0) >= FRONTIER_INPUT_PRICE ? "frontier" : "fast";
}

const CLASS_DEFAULTS: Record<ModelClass, Record<FeatureName, boolean>> = {
	fast: {
		contract: false,
		masking: true,
		contextPack: true,
		parseGate: true,
		editRepair: true,
		pathHints: true,
		loopGuard: true,
		inRunChecks: true,
		checkpoints: true,
		lookup: true,
		diagnostics: true,
		escalation: true,
		localProfile: false,
	},
	frontier: {
		contract: false,
		masking: true,
		contextPack: true,
		parseGate: true,
		editRepair: true,
		pathHints: true,
		loopGuard: true,
		inRunChecks: true,
		checkpoints: true,
		lookup: true,
		diagnostics: true,
		escalation: false,
		localProfile: false,
	},
	local: {
		contract: false,
		masking: true,
		contextPack: true,
		parseGate: true,
		editRepair: true,
		pathHints: true,
		loopGuard: true,
		inRunChecks: true,
		checkpoints: true,
		// Every tool schema costs prompt tokens at ~30 tokens/s on a laptop CPU.
		lookup: false,
		diagnostics: true,
		escalation: false,
		localProfile: true,
	},
};

/** Context pack token budget per class: enough for a map and a few files, well under the window. */
export const CONTEXT_PACK_TOKENS: Record<ModelClass, number> = { fast: 2_000, frontier: 2_500, local: 600 };

/** Parse `+name,-name,name` into switches. Unknown names throw so a typo cannot silently do nothing. */
export function parseFeatureOverrides(text: string | undefined): Partial<Record<FeatureName, boolean>> {
	const overrides: Partial<Record<FeatureName, boolean>> = {};
	if (!text) return overrides;
	for (const raw of text.split(",")) {
		const item = raw.trim();
		if (!item) continue;
		const enabled = !item.startsWith("-");
		const name = item.replace(/^[+-]/, "");
		if (!FEATURE_NAMES.includes(name as FeatureName)) {
			throw new Error(`MIDNIGHT_SERVER_HARNESS_FEATURES: unknown feature "${name}"`);
		}
		overrides[name as FeatureName] = enabled;
	}
	return overrides;
}

/**
 * Resolve every feature for a model class: class default, then `harness.json`, then the
 * environment. Legacy keys (`contract`, `localProfile`, `masking.enabled`) count as config.
 */
export function resolveFeatures(
	modelClass: ModelClass,
	config: Partial<Record<FeatureName, boolean>>,
	env: Partial<Record<FeatureName, boolean>>,
): Record<FeatureName, boolean> {
	return { ...CLASS_DEFAULTS[modelClass], ...config, ...env };
}
