import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type EvidenceCandidate, rankCoverageFiles, selectEvidence } from "../src/harness/context-selection.ts";
import { buildWorkspaceIndex } from "../src/harness/workspace-index.ts";

function objective(candidates: EvidenceCandidate<number>[], selected: number[]): number {
	const covered = new Map<string, number>();
	let value = 0;
	for (const id of selected) {
		const candidate = candidates[id];
		value += candidate.quality;
		for (const [term, weight] of candidate.evidence) covered.set(term, Math.max(weight, covered.get(term) ?? 0));
	}
	return value + 2 * [...covered.values()].reduce((sum, weight) => sum + weight, 0);
}

describe("experimental evidence selection", () => {
	it("prefers a complementary facet over another copy of the same evidence", () => {
		const candidates = [
			{ value: "parser", quality: 1, evidence: new Map([["parse", 1]]) },
			{ value: "parser-copy", quality: 0.9, evidence: new Map([["parse", 1]]) },
			{ value: "writer", quality: 0.8, evidence: new Map([["write", 1]]) },
		];
		expect(selectEvidence(candidates, 2)).toEqual(["parser", "writer"]);
		expect(candidates).toHaveLength(3);
		expect(candidates[0].evidence).toEqual(new Map([["parse", 1]]));
	});

	it("rewards stronger evidence for a covered facet, not its full weight again", () => {
		expect(
			selectEvidence(
				[
					{ value: "anchor", quality: 3, evidence: new Map([["parse", 0.5]]) },
					{ value: "stronger", quality: 0, evidence: new Map([["parse", 1]]) },
					{ value: "new", quality: 0, evidence: new Map([["write", 0.75]]) },
				],
				2,
			),
		).toEqual(["anchor", "new"]);
	});

	it("uses stable order for ties and relevance when there are no facets", () => {
		const candidates = [0, 1, 2].map((value) => ({ value, quality: value === 2 ? 2 : 1, evidence: new Map() }));
		expect(selectEvidence(candidates, 10)).toEqual([2, 0, 1]);
		expect(selectEvidence(candidates, 0)).toEqual([]);
		expect(selectEvidence([], 2)).toEqual([]);
	});

	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid limit %s", (limit) => {
		expect(() => selectEvidence([], limit)).toThrow(RangeError);
	});

	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid weight %s", (weight) => {
		expect(() => selectEvidence([{ value: 0, quality: weight, evidence: new Map() }], 1)).toThrow(RangeError);
		expect(() => selectEvidence([{ value: 0, quality: 0, evidence: new Map([["x", weight]]) }], 1)).toThrow(
			RangeError,
		);
	});

	it("meets the cardinality approximation bound against exhaustive optima on deterministic fixtures", () => {
		let seed = 42;
		const random = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed / 2 ** 32;
		};
		for (let trial = 0; trial < 100; trial++) {
			const candidates = Array.from({ length: 7 }, (_, value) => ({
				value,
				quality: random(),
				evidence: new Map(["a", "b", "c", "d"].map((term) => [term, random() < 0.5 ? 0 : random()])),
			}));
			let optimum = 0;
			for (let mask = 0; mask < 2 ** candidates.length; mask++) {
				const subset = candidates
					.filter((candidate) => mask & (1 << candidate.value))
					.map((candidate) => candidate.value);
				if (subset.length <= 3) optimum = Math.max(optimum, objective(candidates, subset));
			}
			const selected = selectEvidence(candidates, 3);
			expect(new Set(selected).size).toBe(3);
			expect(objective(candidates, selected) + 1e-12).toBeGreaterThanOrEqual((1 - 1 / Math.E) * optimum);
		}
	});

	it("ranks real index entries without mutating them and handles an unmatched request", async () => {
		const dir = mkdtempSync(join(tmpdir(), "midnight-coverage-"));
		try {
			writeFileSync(join(dir, "parser.ts"), "export function parseCsv(text: string) { return text.split(','); }\n");
			writeFileSync(
				join(dir, "writer.ts"),
				"export function writeCsv(cells: string[]) { return cells.join(','); }\n",
			);
			const index = await buildWorkspaceIndex(dir);
			const before = [...index.files];
			const ranked = rankCoverageFiles(index, "parseCsv and writeCsv", 2);
			expect(ranked.map((entry) => entry.file.path).sort()).toEqual(["parser.ts", "writer.ts"]);
			expect(ranked.every((entry) => Number.isFinite(entry.score))).toBe(true);
			expect(index.files).toEqual(before);
			expect(rankCoverageFiles(index, "zzzzunmatched", 2)).toEqual([]);
			expect(rankCoverageFiles(index, "parseCsv", 0)).toEqual([]);
			expect(() => rankCoverageFiles(index, "parseCsv", -1)).toThrow(RangeError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
