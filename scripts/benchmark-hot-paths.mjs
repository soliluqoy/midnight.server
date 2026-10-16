import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { captureCheckpoint, git } from "../src/checkpoints/core.ts";
import { renderContextDocument } from "../src/context/context-document.ts";
import { MirrorStore } from "../src/context/mirror-store.ts";
import { applyProjection, createProjectionCheckpoint } from "../src/context/projection.ts";

const { values } = parseArgs({
	options: {
		output: { type: "string", default: ".artifacts/performance/result.json" },
		scenario: { type: "string", default: "all" },
	},
});
assert.ok(["all", "context", "checkpoints"].includes(values.scenario));
const samples = [];
const root = await mkdtemp(join(tmpdir(), "midnight-performance-"));

async function measure(name, workload, operation) {
	const cpu = process.cpuUsage();
	const heap = process.memoryUsage().heapUsed;
	const start = performance.now();
	const details = await operation();
	const elapsedMs = performance.now() - start;
	const used = process.cpuUsage(cpu);
	const sample = {
		name,
		...workload,
		elapsedMs,
		cpuMs: (used.user + used.system) / 1000,
		heapDeltaBytes: process.memoryUsage().heapUsed - heap,
		...details,
	};
	samples.push(sample);
	return sample;
}

function contextMessages(count, width) {
	return Array.from({ length: count }, (_, index) => {
		const text = `${index} ${"source line with Unicode λ and structured content\n".repeat(width)}`.slice(0, width);
		if (index % 3 === 0) return { role: "user", content: text, timestamp: index };
		if (index % 3 === 1)
			return {
				role: "assistant",
				content: [
					{ type: "text", text },
					{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: `src/${index}.ts"`, limit: 100 } },
				],
				timestamp: index,
			};
		return {
			role: "toolResult",
			content: [{ type: "text", text }],
			toolCallId: `call-${index - 1}`,
			toolName: "read",
			details: { exit_code: 0, nested: { z: [1, { b: true, a: "value" }], a: null } },
			timestamp: index,
		};
	});
}

async function context() {
	const store = await MirrorStore.create("benchmark", root);
	try {
		for (const [name, count, width] of [
			["short", 42, 512],
			["long", 600, 2048],
		]) {
			const messages = contextMessages(count, width);
			const checkpoint = createProjectionCheckpoint({
				revision: 1,
				sourceMessages: messages.slice(0, count / 2),
				projectedMessages: messages.slice(0, count / 4),
				beforeEstimate: 100,
				afterEstimate: 50,
				createdAt: "2026-01-01T00:00:00.000Z",
			});
			let expected;
			for (let iteration = -2; iteration < 15; iteration++) {
				const raw = structuredClone(messages);
				const operation = async () => {
					const projectionStart = performance.now();
					const applied = applyProjection(raw, checkpoint);
					assert.equal(applied.valid, true);
					const projectionMs = performance.now() - projectionStart;
					const renderStart = performance.now();
					const snapshot = renderContextDocument(applied.messages, { revision: 1, documentSeed: "benchmark" });
					const renderMs = performance.now() - renderStart;
					const writeStart = performance.now();
					await store.write(snapshot.text);
					const writeMs = performance.now() - writeStart;
					const digest = createHash("sha256").update(snapshot.text).digest("hex");
					expected ??= digest;
					assert.equal(digest, expected);
					return { projectionMs, renderMs, writeMs, mirrorBytes: Buffer.byteLength(snapshot.text), digest };
				};
				if (iteration < 0) await operation();
				else await measure(`context-${name}`, { iteration, messages: count, contentWidth: width }, operation);
			}
		}
	} finally {
		await store.cleanup();
	}
}

async function checkpoints() {
	const repository = join(root, "repository");
	await mkdir(repository);
	await git(repository, ["init", "-q", "--initial-branch=main"]);
	await git(repository, ["config", "user.name", "Benchmark"]);
	await git(repository, ["config", "user.email", "benchmark@local.invalid"]);
	await git(repository, ["config", "core.autocrlf", "false"]);
	const files = Array.from({ length: 128 }, (_, index) => `file ${index} λ.txt`);
	for (const file of files) await writeFile(join(repository, file), `base ${file}\n${"x".repeat(1024)}`);
	await git(repository, ["add", "--all"]);
	await git(repository, ["commit", "-qm", "fixture"]);
	const options = { sessionId: "benchmark", trigger: "turn", deduplicate: true };
	let previous = await captureCheckpoint(repository, options);
	const trace = join(repository, ".git", "benchmark-trace.json");
	const priorTrace = process.env.GIT_TRACE2_EVENT;
	try {
		for (const scenario of ["unchanged", "changed"]) {
			for (let iteration = 0; iteration < 3; iteration++) {
				if (scenario === "changed")
					for (const file of files.slice(0, 64))
						await writeFile(join(repository, file), `${iteration} ${file}\n${"y".repeat(1024)}`);
				await writeFile(trace, "");
				process.env.GIT_TRACE2_EVENT = trace;
				const retained = previous;
				const sample = await measure(`checkpoint-${scenario}`, { iteration, files: files.length }, async () => {
					previous = await captureCheckpoint(repository, { ...options, previous });
					return { covered: previous.covered.length, exclusions: previous.excluded.length };
				});
				if (scenario === "unchanged") assert.equal(previous.ref, retained.ref);
				assert.equal(previous.covered.length, files.length);
				assert.equal(previous.excluded.length, 0);
				const commands = (await readFile(trace, "utf8"))
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
					.filter((event) => event.event === "start")
					.map((event) => event.argv);
				sample.gitProcesses = commands.length;
				sample.hashObjectProcesses = commands.filter((args) => args.includes("hash-object")).length;
			}
		}
	} finally {
		if (priorTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
		else process.env.GIT_TRACE2_EVENT = priorTrace;
	}
}

try {
	if (values.scenario !== "checkpoints") await context();
	if (values.scenario !== "context") await checkpoints();
	const groups = [...new Set(samples.map((sample) => sample.name))].map((name) => {
		const rows = samples.filter((sample) => sample.name === name);
		const summary = { name, samples: rows.length };
		for (const key of [
			"elapsedMs",
			"cpuMs",
			"projectionMs",
			"renderMs",
			"writeMs",
			"gitProcesses",
			"hashObjectProcesses",
		])
			if (rows.every((row) => typeof row[key] === "number")) {
				const sorted = rows.map((row) => row[key]).sort((a, b) => a - b);
				summary[key] = {
					median: sorted[Math.floor(sorted.length / 2)],
					p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
				};
			}
		return summary;
	});
	const output = resolve(values.output);
	await mkdir(dirname(output), { recursive: true });
	await writeFile(
		output,
		`${JSON.stringify({ node: process.version, platform: process.platform, groups, samples }, null, 2)}\n`,
	);
	console.log(JSON.stringify({ output, groups }, null, 2));
} finally {
	await rm(root, { recursive: true, force: true });
}
