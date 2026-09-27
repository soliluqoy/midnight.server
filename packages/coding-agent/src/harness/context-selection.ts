import { identifierTerms } from "./outline.ts";
import { type RankedFile, rankFiles, type WorkspaceIndex } from "./workspace-index.ts";

export interface EvidenceCandidate<T> {
	value: T;
	/** Nonnegative relevance, on the same scale as the total evidence weight. */
	quality: number;
	/** Nonnegative weighted evidence strength for each query facet. */
	evidence: ReadonlyMap<string, number>;
}

/**
 * Greedy maximization of F(S) = sum quality(i) + 2 sum_t max_{i in S} evidence(i,t).
 * This normalized monotone submodular objective rewards relevant files but gives a
 * repeated facet only its strongest evidence. Stable input order breaks ties.
 *
 * With nonnegative finite inputs and a cardinality limit, greedy has the standard
 * (1 - 1/e) approximation bound. That bound is about this surrogate objective, not
 * task accuracy, token packing, or files outside the candidate pool.
 */
export function selectEvidence<T>(candidates: readonly EvidenceCandidate<T>[], limit: number): T[] {
	if (!Number.isInteger(limit) || limit < 0) throw new RangeError("limit must be a nonnegative integer");
	for (const candidate of candidates) {
		if (!Number.isFinite(candidate.quality) || candidate.quality < 0) {
			throw new RangeError("quality must be finite and nonnegative");
		}
		for (const value of candidate.evidence.values()) {
			if (!Number.isFinite(value) || value < 0) throw new RangeError("evidence must be finite and nonnegative");
		}
	}
	const covered = new Map<string, number>();
	const remaining = [...candidates];
	const selected: T[] = [];
	while (selected.length < limit && remaining.length > 0) {
		let best = 0;
		let bestGain = -1;
		for (let i = 0; i < remaining.length; i++) {
			const candidate = remaining[i];
			let gain = candidate.quality;
			for (const [term, weight] of candidate.evidence) {
				gain += 2 * Math.max(0, weight - (covered.get(term) ?? 0));
			}
			if (gain > bestGain) {
				best = i;
				bestGain = gain;
			}
		}
		const [candidate] = remaining.splice(best, 1);
		selected.push(candidate.value);
		for (const [term, weight] of candidate.evidence) {
			covered.set(term, Math.max(weight, covered.get(term) ?? 0));
		}
	}
	return selected;
}

/** Experimental reranking: bounded lexical retrieval, no embeddings or model calls. */
export function rankCoverageFiles(index: WorkspaceIndex, request: string, limit = 10): RankedFile[] {
	if (!Number.isInteger(limit) || limit < 0) throw new RangeError("limit must be a nonnegative integer");
	if (limit === 0) return [];
	const candidates = rankFiles(index, request, Math.max(40, limit));
	if (candidates.length === 0) return [];
	const weights = new Map<string, number>();
	for (const term of new Set(identifierTerms(request))) {
		const df = index.documentFrequency.get(term) ?? 0;
		if (df > 0) weights.set(term, Math.log(1 + (index.files.length - df + 0.5) / (df + 0.5)));
	}
	const totalWeight = [...weights.values()].reduce((sum, value) => sum + value, 0);
	const maxScore = Math.max(...candidates.map((candidate) => candidate.score));
	return selectEvidence(
		candidates.map((candidate) => {
			const evidence = new Map<string, number>();
			for (const [term, weight] of weights) {
				if (!candidate.file.terms.has(term)) continue;
				// A declaration/path is stronger evidence than a mention in a body.
				evidence.set(term, (weight / totalWeight) * (candidate.file.nameTerms.has(term) ? 1 : 0.25));
			}
			return { value: candidate, quality: candidate.score / maxScore, evidence };
		}),
		limit,
	);
}
