/**
 * Experiment design for scripts/harness-eval.mjs: which variants run, with exactly which harness
 * features, in which order. Pure functions, unit-tested in harness-eval-design.test.mjs.
 *
 * Two ways to name variants:
 *
 * - `--variants bare,harness,no-pack=-contextPack,+contract`: a token that starts with + or -
 *   belongs to the variant before it, so a variant can switch several features.
 * - `--manifest <file>`: an explicit design. Every harness variant gets its complete feature
 *   assignment (the manifest's `fixed` switches plus the variant's own), so no default can
 *   silently differ between arms, and each run records exactly what it was assigned.
 *
 * Manifest (schema_version 1):
 *   {
 *     "schema_version": 1,
 *     "experiment_id": "drift-pilot-01",
 *     "task_split": "dev" | "holdout" | "all",
 *     "only": ["task", ...],                      optional
 *     "factor_order": ["driftGuard", "blockerExit"],
 *     "fixed": { "escalation": false, "decisions": false },
 *     "variants": [
 *       { "id": "00", "features": { "driftGuard": false, "blockerExit": false } },
 *       { "id": "bare", "harness": false }
 *     ],
 *     "repeats": 2,
 *     "order_seed": 41,
 *     "agent_args": ["--model", "openai-codex/gpt-6-luna"]      optional
 *   }
 */

export function parseVariant(text) {
	const [name, features] = text.split("=");
	if (name === "bare") return { name, harness: false };
	return { name, harness: true, features: features ?? (name === "harness" ? "" : undefined) };
}

/** Parse `--variants`. A +feature or -feature token extends the variant before it. */
export function parseVariantList(text) {
	const variants = [];
	for (const token of text
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)) {
		const last = variants[variants.length - 1];
		if (/^[+-]/.test(token) && last?.harness) {
			last.features = last.features ? `${last.features},${token}` : token;
		} else {
			variants.push(parseVariant(token));
		}
	}
	for (const variant of variants) {
		if (variant.harness && variant.features === undefined) {
			throw new Error(`Variant ${variant.name}: use bare, harness, or name=+feature,-feature`);
		}
	}
	return variants;
}

/**
 * Validate a manifest and resolve its variants. `knownFeatures` is the harness's feature list;
 * unknown names are rejected so a typo cannot run as the default.
 */
export function resolveManifest(manifest, knownFeatures) {
	const problems = [];
	if (manifest?.schema_version !== 1) problems.push("schema_version must be 1");
	if (typeof manifest?.experiment_id !== "string" || !manifest.experiment_id) problems.push("experiment_id is required");
	const split = manifest?.task_split ?? "all";
	if (!["all", "dev", "holdout"].includes(split)) problems.push("task_split must be all, dev or holdout");
	const factors = manifest?.factor_order ?? [];
	const fixed = manifest?.fixed ?? {};
	const known = new Set(knownFeatures);
	for (const name of [...factors, ...Object.keys(fixed)]) {
		if (!known.has(name)) problems.push(`unknown feature ${name}`);
	}
	for (const name of factors) if (name in fixed) problems.push(`${name} is both a factor and fixed`);
	if (!Array.isArray(manifest?.variants) || manifest.variants.length === 0) problems.push("variants must be a non-empty array");
	const ids = new Set();
	const variants = [];
	for (const variant of manifest?.variants ?? []) {
		if (typeof variant.id !== "string" || !variant.id) {
			problems.push("every variant needs an id");
			continue;
		}
		if (ids.has(variant.id)) problems.push(`duplicate variant id ${variant.id}`);
		ids.add(variant.id);
		if (variant.harness === false) {
			variants.push({ name: variant.id, harness: false, assignment: {} });
			continue;
		}
		const own = variant.features ?? {};
		for (const [name, value] of Object.entries(own)) {
			if (!known.has(name)) problems.push(`${variant.id}: unknown feature ${name}`);
			if (typeof value !== "boolean") problems.push(`${variant.id}: ${name} must be true or false`);
			if (name in fixed) problems.push(`${variant.id}: ${name} is fixed by the manifest`);
		}
		for (const name of factors) {
			if (typeof own[name] !== "boolean") problems.push(`${variant.id}: factor ${name} is not assigned`);
		}
		const assignment = { ...fixed, ...own };
		variants.push({
			name: variant.id,
			harness: true,
			assignment,
			features: Object.entries(assignment)
				.map(([name, value]) => `${value ? "+" : "-"}${name}`)
				.join(","),
		});
	}
	// Two harness variants with the same assignment would measure noise under two names.
	const seen = new Map();
	for (const variant of variants.filter((item) => item.harness)) {
		const key = variant.features;
		if (seen.has(key)) problems.push(`variants ${seen.get(key)} and ${variant.name} have the same assignment`);
		seen.set(key, variant.name);
	}
	const repeats = manifest?.repeats ?? 1;
	if (!Number.isInteger(repeats) || repeats < 1) problems.push("repeats must be a positive integer");
	if (problems.length > 0) throw new Error(`Invalid manifest:\n  ${problems.join("\n  ")}`);
	return {
		experimentId: manifest.experiment_id,
		split,
		only: manifest.only,
		factors,
		variants,
		repeats,
		orderSeed: manifest.order_seed ?? 1,
		agentArgs: manifest.agent_args ?? [],
	};
}

/** A seeded shuffle (Fisher-Yates over a linear congruential generator). */
export function seededShuffle(items, seed) {
	const result = [...items];
	let state = seed >>> 0 || 1;
	const random = () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
	for (let index = result.length - 1; index > 0; index--) {
		const other = Math.floor(random() * (index + 1));
		[result[index], result[other]] = [result[other], result[index]];
	}
	return result;
}
