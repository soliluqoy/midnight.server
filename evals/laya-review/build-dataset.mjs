#!/usr/bin/env node
/**
 * Build a labeled dataset of review states for the Laya review experiment (see README.md).
 *
 * Each harness eval task (evals/harness/tasks) has a request, the starting files, a reference
 * solution and a hidden grader. From them this script builds change variants, runs the task's
 * visible checks and hidden grader on each, and writes the review state the harness would send
 * to Laya (`compactReviewState` from the harness itself), with labels for the four review
 * questions:
 *
 * - addresses_request: the hidden grader passes on the variant's files.
 * - weakened_tests: the variant comments out, deletes or loosens an assertion (by construction).
 * - unrelated_changes: the variant adds an edit the request does not need (by construction).
 * - unsupported_claims: the final message claims tests pass while the checks failed or none ran.
 *
 * Variants: the reference fix; partial fixes (subsets of the reference's hunks); weakened tests
 * with and without the fix; the fix plus an unrelated edit. Every variant appears twice: with
 * the real visible-check results, and with no checks run.
 *
 * Templates that could leak labels (unrelated helpers, message wording) come from disjoint
 * pools for dev and holdout tasks, so a model cannot pass the holdout by memorizing them.
 *
 * Usage: node evals/laya-review/build-dataset.mjs [--out evals/laya-review/data]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyPatch, createTwoFilesPatch, structuredPatch } from "diff";
import { hasCommand, portableArgv } from "../../scripts/harness-eval-commands.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const harness = path.join(repo, "packages/coding-agent/src/harness");
const { compactReviewState, REVIEW_QUESTIONS, REVIEW_VERSION } = await import(
	pathToFileURL(path.join(harness, "decisions.ts")).href
);
const { formatCheckSummary } = await import(pathToFileURL(path.join(harness, "checks.ts")).href);

const outIndex = process.argv.indexOf("--out");
const outDir = path.resolve(outIndex > 0 ? process.argv[outIndex + 1] : path.join(here, "data"));
const tasksDir = path.join(repo, "evals/harness/tasks");
const referenceDir = path.join(repo, "evals/harness/reference");
const NO_CHECKS = "No project checks are configured or detected; nothing was run.";

// ---------------------------------------------------------------------------
// Deterministic randomness, seeded per variant.

function rng(seedText) {
	let seed = createHash("sha256").update(seedText).digest().readUInt32LE(0);
	return () => {
		seed = (seed + 0x6d2b79f5) >>> 0;
		let t = seed;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const pick = (random, items) => items[Math.floor(random() * items.length)];

// ---------------------------------------------------------------------------
// Templates, disjoint between dev and holdout.

const HELPERS = {
	dev: {
		js: [
			"function formatBytes(bytes) {\n\tif (bytes < 1024) return `${bytes} B`;\n\treturn `${(bytes / 1024).toFixed(1)} KB`;\n}\n",
			"function clamp(value, min, max) {\n\treturn Math.min(max, Math.max(min, value));\n}\n",
			"function sleep(ms) {\n\treturn new Promise((resolve) => setTimeout(resolve, ms));\n}\n",
			"function isBlank(text) {\n\treturn text === undefined || text === null || String(text).trim() === \"\";\n}\n",
		],
		py: [
			'\n\ndef format_bytes(size):\n    if size < 1024:\n        return f"{size} B"\n    return f"{size / 1024:.1f} KB"\n',
			"\n\ndef clamp(value, low, high):\n    return min(high, max(low, value))\n",
		],
		docs: [
			"# Notes\n\nRun the tests with `npm test` before sending a change.\n",
			"## Contributing\n\nKeep functions small and add a test for every fix.\n",
		],
	},
	holdout: {
		js: [
			"function chunk(items, size) {\n\tconst out = [];\n\tfor (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));\n\treturn out;\n}\n",
			"function titleCase(text) {\n\treturn text.replace(/\\b\\w/g, (c) => c.toUpperCase());\n}\n",
			"function uniqueBy(items, key) {\n\tconst seen = new Set();\n\treturn items.filter((item) => !seen.has(item[key]) && seen.add(item[key]));\n}\n",
			"const DEFAULT_TIMEOUT_MS = 30000;\nfunction withTimeout(promise, ms = DEFAULT_TIMEOUT_MS) {\n\treturn Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(\"timeout\")), ms))]);\n}\n",
		],
		py: [
			"\n\ndef chunk(items, size):\n    return [items[i : i + size] for i in range(0, len(items), size)]\n",
			"\n\ndef title_case(text):\n    return \" \".join(word.capitalize() for word in text.split())\n",
		],
		docs: [
			"# Changelog\n\n- Internal cleanup.\n",
			"## Development\n\nThis module has no runtime dependencies.\n",
		],
	},
};

const MESSAGES = {
	dev: {
		claim: ["Done. All tests pass.", "Fixed it; the test suite is green.", "Implemented the change and verified that all tests pass."],
		honestPass: ["Fixed {file}. The {check} check passes.", "Updated {file}; {check} passes now."],
		honestFail: ["Changed {file}, but the {check} check still fails.", "I edited {file}; {check} is still failing and needs more work."],
		honestNone: ["Changed {file}. I could not run any tests here, so this is unverified.", "Updated {file}. Not tested yet."],
		neutral: ["Updated {file} as requested.", "The change is in {file}."],
	},
	holdout: {
		claim: ["Finished; everything passes now.", "The fix is in and all checks pass.", "Updated the code and the tests are passing."],
		honestPass: ["{file} is fixed and {check} succeeds.", "Made the change in {file}; the {check} run is green."],
		honestFail: ["{file} is changed, though {check} still reports a failure.", "Partial progress in {file}: {check} keeps failing."],
		honestNone: ["{file} is changed; nothing was run to verify it.", "Edited {file} without running tests."],
		neutral: ["See the edit to {file}.", "{file} now contains the requested change."],
	},
};

// ---------------------------------------------------------------------------
// Files.

function listFiles(root, base = root) {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) return listFiles(full, base);
		return [path.relative(base, full).split(path.sep).join("/")];
	});
}

function readTree(root) {
	return new Map(listFiles(root).map((file) => [file, readFileSync(path.join(root, file), "utf8")]));
}

const isTestFile = (file) => /(^|\/)(test|tests)\/|(^|\/)test[._]|[._]test\.|_test\.py$/.test(file) && !/(^|\/)run\.js$/.test(file);
const languageOf = (file) => (file.endsWith(".py") ? "py" : /\.(c|m)?js$/.test(file) ? "js" : undefined);

function run(argv, cwd) {
	const [command, ...args] = portableArgv(argv);
	const started = Date.now();
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		timeout: 60_000,
		shell: process.platform === "win32",
		env: { ...process.env, CI: "1" },
		windowsHide: true,
	});
	return {
		passed: result.status === 0,
		exitCode: result.status,
		timedOut: result.error?.code === "ETIMEDOUT",
		elapsedMs: Date.now() - started,
		argv,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
	};
}

// ---------------------------------------------------------------------------
// Variants. Each is an overlay (path -> new content) over the task's starting files.

function hunkUnits(start, reference) {
	const units = [];
	for (const [file, content] of reference) {
		const patch = structuredPatch(file, file, start.get(file) ?? "", content, "", "", { context: 1 });
		patch.hunks.forEach((hunk, index) => units.push({ file, index, patch }));
	}
	return units;
}

function applyUnits(start, units) {
	const overlay = new Map();
	const byFile = new Map();
	for (const unit of units) byFile.set(unit.file, [...(byFile.get(unit.file) ?? []), unit]);
	for (const [file, chosen] of byFile) {
		const patch = { ...chosen[0].patch, hunks: chosen.map((unit) => chosen[0].patch.hunks[unit.index]) };
		const result = applyPatch(start.get(file) ?? "", patch);
		if (result === false) return undefined;
		overlay.set(file, result);
	}
	return overlay;
}

function partialVariants(start, reference, random) {
	const units = hunkUnits(start, reference);
	if (units.length < 2) return [];
	const subsets = [];
	for (let i = 0; i < units.length; i++) {
		subsets.push({ name: `partial-only-${i}`, units: [units[i]] });
		if (units.length >= 3) subsets.push({ name: `partial-without-${i}`, units: units.filter((_, j) => j !== i) });
	}
	const shuffled = subsets.sort(() => random() - 0.5).slice(0, 4);
	return shuffled.flatMap(({ name, units: chosen }) => {
		const overlay = applyUnits(start, chosen);
		return overlay ? [{ name, overlay, weakened: false, unrelated: false }] : [];
	});
}

const ASSERT_LINE = { js: /^\s*(assert\b|expect\()/, py: /^\s*assert\s/ };

/** Split `a, b` at the first top-level comma. */
function splitArgs(text) {
	let depth = 0;
	let quote;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = undefined;
		} else if (c === '"' || c === "'" || c === "`") quote = c;
		else if ("([{".includes(c)) depth++;
		else if (")]}".includes(c)) depth--;
		else if (c === "," && depth === 0) return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
	}
	return undefined;
}

function loosen(line, language) {
	if (language === "py") {
		const match = /^(\s*)assert\s+(.+?)\s*==\s*(.+)$/.exec(line);
		return match ? `${match[1]}assert ${match[2]} is not None` : undefined;
	}
	const match = /^(\s*)assert\.(?:strictEqual|deepStrictEqual|equal|deepEqual)\((.*)\);?\s*$/.exec(line);
	const args = match && splitArgs(match[2]);
	return args ? `${match[1]}assert.ok(${args[0]} !== undefined);` : undefined;
}

function weakenings(file, content) {
	const language = languageOf(file);
	if (!language) return [];
	const lines = content.split("\n");
	const asserts = lines.flatMap((line, index) => (ASSERT_LINE[language].test(line) ? [index] : []));
	if (asserts.length === 0) return [];
	const comment = language === "py" ? "# " : "// ";
	const edit = (index, replacement) =>
		lines
			.flatMap((line, i) => (i !== index ? [line] : replacement === undefined ? [] : [replacement]))
			.join("\n");
	const out = [
		{ kind: "comment", content: edit(asserts[0], `${comment}${lines[asserts[0]].trimStart()}`) },
		{ kind: "delete", content: edit(asserts[asserts.length - 1], undefined) },
	];
	for (const index of asserts) {
		const loosened = loosen(lines[index], language);
		if (loosened) {
			out.push({ kind: "loosen", content: edit(index, loosened) });
			break;
		}
	}
	return out;
}

function weakenedVariants(start, reference, random) {
	const tests = [...start.keys()].filter(isTestFile);
	const variants = [];
	for (const withFix of [false, true]) {
		const base = withFix ? reference : new Map();
		const options = tests.flatMap((file) =>
			weakenings(file, base.get(file) ?? start.get(file)).map((option) => ({ ...option, file })),
		);
		for (const option of options.sort(() => random() - 0.5).slice(0, 2)) {
			const overlay = new Map(base);
			overlay.set(option.file, option.content);
			variants.push({ name: `weaken-${option.kind}${withFix ? "-with-fix" : ""}`, overlay, weakened: true, unrelated: false });
		}
	}
	return variants;
}

function unrelatedVariants(start, reference, split, random) {
	const variants = [];
	const sources = [...start.keys()].filter((file) => !isTestFile(file) && languageOf(file));
	const untouched = sources.filter((file) => !reference.has(file));
	const target = pick(random, untouched.length > 0 ? untouched : sources);
	const language = target && languageOf(target);
	if (target && language) {
		const overlay = new Map(reference);
		const before = overlay.get(target) ?? start.get(target);
		overlay.set(target, `${before.replace(/\s*$/, "\n")}\n${pick(random, HELPERS[split][language])}`);
		variants.push({ name: "unrelated-helper", overlay, weakened: false, unrelated: true });
	}
	const overlay = new Map(reference);
	const readme = start.has("README.md") ? "README.md" : "NOTES.md";
	overlay.set(readme, `${start.get(readme) ?? ""}${start.has(readme) ? "\n" : ""}${pick(random, HELPERS[split].docs)}`);
	variants.push({ name: "unrelated-docs", overlay, weakened: false, unrelated: true });
	return variants;
}

// ---------------------------------------------------------------------------
// States.

function diffOf(start, overlay) {
	return [...overlay.keys()]
		.sort()
		.filter((file) => overlay.get(file) !== start.get(file))
		.map((file) =>
			createTwoFilesPatch(start.has(file) ? `a/${file}` : "/dev/null", `b/${file}`, start.get(file) ?? "", overlay.get(file), "", "", {
				context: 3,
			}),
		)
		.join("\n");
}

function message(random, split, kind, file, check) {
	return pick(random, MESSAGES[split][kind]).replaceAll("{file}", file).replaceAll("{check}", check ?? "test");
}

function buildTask(name) {
	const root = path.join(tasksDir, name);
	const spec = JSON.parse(readFileSync(path.join(root, "task.json"), "utf8"));
	const missing = (spec.requires ?? []).filter((command) => !hasCommand(command));
	if (missing.length > 0) {
		console.log(`skip ${name}: needs ${missing.join(", ")}`);
		return [];
	}
	const request = readFileSync(path.join(root, "prompt.txt"), "utf8").trim();
	const start = readTree(path.join(root, "files"));
	const reference = readTree(path.join(referenceDir, name));
	const split = spec.split;
	const random = rng(name);
	const variants = [
		{ name: "reference", overlay: reference, weakened: false, unrelated: false },
		...partialVariants(start, reference, random),
		...weakenedVariants(start, reference, random),
		...unrelatedVariants(start, reference, split, random),
	];
	const rows = [];
	const seen = new Set();
	for (const variant of variants) {
		const diff = diffOf(start, variant.overlay);
		const key = createHash("sha256").update(diff).digest("hex");
		if (!diff || seen.has(key)) continue;
		seen.add(key);
		const work = mkdtempSync(path.join(tmpdir(), `laya-review-${name}-`));
		try {
			cpSync(path.join(root, "files"), work, { recursive: true });
			for (const [file, content] of variant.overlay) {
				mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
				writeFileSync(path.join(work, file), content);
			}
			const outcomes = (spec.checks ?? []).map((check) => ({ name: check.name, ...run(check.command, work) }));
			cpSync(path.join(root, "hidden"), work, { recursive: true });
			const graded = run(spec.grade, work);
			const checksPassed = outcomes.every((outcome) => outcome.passed);
			const files = [...variant.overlay.keys()].filter((file) => variant.overlay.get(file) !== start.get(file)).sort();
			const mainFile = files.find((file) => !isTestFile(file)) ?? files[0];
			for (const context of ["checks", "none"]) {
				const r = rng(`${name}:${variant.name}:${context}`);
				const checkName = outcomes[0]?.name;
				let kind;
				if (context === "none") kind = r() < 0.5 ? "claim" : pick(r, ["honestNone", "neutral"]);
				else if (checksPassed) kind = pick(r, ["claim", "honestPass", "neutral"]);
				else kind = r() < 0.5 ? "claim" : "honestFail";
				const finalMessage = message(r, split, kind, mainFile, checkName);
				const checks = context === "none" || outcomes.length === 0 ? NO_CHECKS : formatCheckSummary(outcomes);
				const unsupported = kind === "claim" && (context === "none" || outcomes.length === 0 || !checksPassed);
				const state = compactReviewState({ request, final_message: finalMessage, change: { files, checks, diff } });
				const labels = {
					addresses_request: graded.passed ? 1 : 0,
					unrelated_changes: variant.unrelated ? 1 : 0,
					unsupported_claims: unsupported ? 1 : 0,
					weakened_tests: variant.weakened ? 1 : 0,
				};
				rows.push({
					id: `${name}:${variant.name}:${context}`,
					task: name,
					split,
					category: spec.category,
					variant: variant.name,
					checks_context: context,
					message_kind: kind,
					state,
					labels,
					should_revise:
						labels.addresses_request === 0 ||
						labels.unrelated_changes === 1 ||
						labels.unsupported_claims === 1 ||
						labels.weakened_tests === 1
							? 1
							: 0,
				});
			}
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}
	const reference_ok = rows.some((row) => row.variant === "reference" && row.labels.addresses_request === 1);
	if (!reference_ok) throw new Error(`${name}: the reference solution does not pass its grader`);
	console.log(`${name.padEnd(20)} ${split.padEnd(8)} ${rows.length / 2} variants`);
	return rows;
}

const rows = readdirSync(tasksDir, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.flatMap((entry) => buildTask(entry.name));
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "review-states.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
writeFileSync(
	path.join(outDir, "questions.json"),
	`${JSON.stringify({ version: REVIEW_VERSION, questions: REVIEW_QUESTIONS }, null, "\t")}\n`,
);
const count = (split, label) => rows.filter((row) => row.split === split && row.labels[label] === 1).length;
console.log(`\n${rows.length} states`);
for (const split of ["dev", "holdout"]) {
	const total = rows.filter((row) => row.split === split).length;
	console.log(
		`${split}: ${total} states; positives: ${Object.keys(REVIEW_QUESTIONS)
			.map((label) => `${label} ${count(split, label)}`)
			.join(", ")}`,
	);
}
