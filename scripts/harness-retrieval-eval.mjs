/** Offline localization only: reads snapshots; never executes their code or calls a model. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { rankCoverageFiles } from "../packages/coding-agent/src/harness/context-selection.ts";
import { buildWorkspaceIndex, rankFiles } from "../packages/coding-agent/src/harness/workspace-index.ts";

export function scoreRanking(paths, goldPaths) {
	const gold = new Set(goldPaths);
	if (gold.size === 0) return { recall: null, reciprocalRank: null, allFound: null };
	const found = new Set(paths.filter((path) => gold.has(path)));
	const first = paths.findIndex((path) => gold.has(path));
	return {
		recall: found.size / gold.size,
		reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
		allFound: found.size === gold.size,
	};
}

export function summarize(records) {
	const result = {};
	for (const variant of ["bm25", "coverage"]) {
		const scored = records.filter((record) => record[variant].at10.recall !== null);
		result[variant] = {
			tasks: scored.length,
			recallAt5: scored.length ? scored.reduce((sum, row) => sum + row[variant].at5.recall, 0) / scored.length : null,
			recallAt10: scored.length ? scored.reduce((sum, row) => sum + row[variant].at10.recall, 0) / scored.length : null,
			mrrAt10: scored.length
				? scored.reduce((sum, row) => sum + row[variant].at10.reciprocalRank, 0) / scored.length
				: null,
			allFoundAt10: scored.filter((row) => row[variant].at10.allFound).length,
		};
	}
	return result;
}

async function main() {
	const [manifestPath, outputPath, ...extra] = process.argv.slice(2);
	if (!manifestPath || !outputPath || extra.length) {
		throw new Error("Usage: node scripts/harness-retrieval-eval.mjs <manifest.json> <results.json> (Node 22.18+)");
	}
	const raw = readFileSync(manifestPath);
	const manifest = JSON.parse(raw.toString("utf8"));
	if (manifest.schemaVersion !== 1 || manifest.split !== "dev" || !Array.isArray(manifest.tasks)) {
		throw new Error("Expected a schemaVersion 1 dev manifest; reserve holdout data for the frozen experiment");
	}
	const records = [];
	const ids = new Set();
	for (const task of manifest.tasks) {
		if (
			typeof task.id !== "string" ||
			ids.has(task.id) ||
			typeof task.root !== "string" ||
			typeof task.request !== "string" ||
			!Array.isArray(task.goldPaths) ||
			!task.goldPaths.every((path) => typeof path === "string")
		) {
			throw new Error("Invalid or duplicate task in manifest");
		}
		ids.add(task.id);
		const index = await buildWorkspaceIndex(resolve(task.root));
		const goldPaths = [...new Set(task.goldPaths)];
		const eligible = goldPaths.filter((path) => index.byPath.has(path));
		const excluded = goldPaths.filter((path) => !index.byPath.has(path));
		const record = {
			id: task.id,
			repo: task.repo,
			baseCommit: task.baseCommit,
			archiveSha256: task.archiveSha256,
			files: index.files.length,
			indexTruncated: index.truncated,
			goldPaths,
			eligible,
			excluded,
		};
		// The rankers receive only the issue and the base tree, never the gold paths or patch.
		for (const [variant, ranker] of [["bm25", rankFiles], ["coverage", rankCoverageFiles]]) {
			const start = performance.now();
			const paths = ranker(index, task.request, 10).map((item) => item.file.path);
			record[variant] = {
				paths,
				ms: performance.now() - start,
				at5: scoreRanking(paths.slice(0, 5), eligible),
				at10: scoreRanking(paths, eligible),
			};
		}
		records.push(record);
		console.log(`${task.id}: ${index.files.length} files; recall@10 ${record.bm25.at10.recall} -> ${record.coverage.at10.recall}; excluded ${excluded.length}`);
	}
	const result = {
		schemaVersion: 1,
		kind: "offline-file-localization-not-task-resolution",
		dataset: manifest.dataset,
		split: manifest.split,
		manifestSha256: createHash("sha256").update(raw).digest("hex"),
		metadataSha256: manifest.metadataSha256,
		summary: summarize(records),
		records,
	};
	writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
	console.log(JSON.stringify(result.summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	await main();
}
