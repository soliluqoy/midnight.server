import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreRanking, summarize } from "./harness-retrieval-eval.mjs";

test("retrieval metrics do not count duplicates or missing targets as hits", () => {
	assert.deepEqual(scoreRanking(["a", "a", "c"], ["a", "b", "b"]), {
		recall: 0.5,
		reciprocalRank: 1,
		allFound: false,
	});
	assert.deepEqual(scoreRanking(["z", "b", "a"], ["a", "b"]), {
		recall: 1,
		reciprocalRank: 0.5,
		allFound: true,
	});
	assert.deepEqual(scoreRanking([], ["a"]), { recall: 0, reciprocalRank: 0, allFound: false });
});

test("an unindexable target set is unscored, not a success", () => {
	assert.deepEqual(scoreRanking(["a"], []), { recall: null, reciprocalRank: null, allFound: null });
	const skipped = { at5: scoreRanking([], []), at10: scoreRanking([], []) };
	assert.deepEqual(summarize([{ bm25: skipped, coverage: skipped }]), summarize([]));
	assert.equal(summarize([]).bm25.recallAt10, null);
});

test("macro averaging weights issues equally, not repositories with more changed files", () => {
	const full = { at5: scoreRanking(["a"], ["a"]), at10: scoreRanking(["a"], ["a"]) };
	const half = { at5: scoreRanking(["a"], ["a", "b"]), at10: scoreRanking(["a"], ["a", "b"]) };
	const result = summarize([{ bm25: full, coverage: half }, { bm25: half, coverage: full }]);
	assert.equal(result.bm25.tasks, 2);
	assert.equal(result.bm25.recallAt10, 0.75);
	assert.equal(result.bm25.allFoundAt10, 1);
	assert.deepEqual(result.bm25, result.coverage);
});
