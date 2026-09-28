/**
 * Harness features and their defaults.
 *
 * The default set is what stays cheap: guards that fix a tool call or add a line to a result the
 * model is already waiting for, and one verification pass when the run settles. Everything that
 * costs model turns, process time on every request or a second model is opt-in until a receipt
 * against vanilla Pi shows it pays for itself (docs/WORKFLOW_PLAN.md).
 *
 * Every feature can be switched in `harness.json` (`features: { name: true }`) and, for
 * measurement, with `MIDNIGHT_SERVER_HARNESS_FEATURES=+contextPack,-driftGuard`. The eval
 * (`scripts/harness-eval.mjs`) builds ablation variants from that variable.
 */
export const FEATURE_NAMES = [
	/** Reject edits that break a file's syntax, restoring the previous content. */
	"parseGate",
	/** Indentation-tolerant edit matching and closest-match hints when oldText is not found. */
	"editRepair",
	/** "Did you mean" suggestions when a path does not exist. */
	"pathHints",
	/** Tell the model when it repeats the same call or the same failing command. */
	"loopGuard",
	/**
	 * When a static check (types, lint) fails at settle, run it once more on the tree as the request
	 * found it and hold back failures the project already had. See baseline.ts.
	 */
	"checkBaseline",
	/**
	 * Compare the finished change with the request (weakened tests, hard-coded test inputs,
	 * stubs, swallowed errors, removed declarations, unverified success claims) and ask once to
	 * fix or disclose. See drift.ts.
	 */
	"driftGuard",
	/** One rule offering a sanctioned way to stop: report what blocks the request instead of substituting. */
	"blockerExit",
	/** Opt-in. Repo map, ranked files and their contents in the first request of a session. */
	"contextPack",
	/** Opt-in. The `lookup` tool: definitions, references and outlines through LSP or syntax outlines. */
	"lookup",
	/** Opt-in. New language-server errors reported with each edit result (waits for the server). */
	"diagnostics",
	/** Opt-in. Ask a stronger model for advice with the repair feedback when the checks fail. */
	"escalation",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

export const DEFAULT_FEATURES: Record<FeatureName, boolean> = {
	parseGate: true,
	editRepair: true,
	pathHints: true,
	loopGuard: true,
	checkBaseline: true,
	driftGuard: true,
	blockerExit: true,
	contextPack: false,
	lookup: false,
	diagnostics: false,
	escalation: false,
};

/** Context pack token budget: enough for a map and a few files, well under the window. */
export const CONTEXT_PACK_TOKENS = 2_000;

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

/** Resolve every feature: defaults, then `harness.json`, then the environment. */
export function resolveFeatures(
	config: Partial<Record<FeatureName, boolean>>,
	env: Partial<Record<FeatureName, boolean>>,
): Record<FeatureName, boolean> {
	return { ...DEFAULT_FEATURES, ...config, ...env };
}
