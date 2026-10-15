import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { ContextTrimmer } from "../src/context/trim.ts";
import type { LiveContextMessage } from "../src/context/types.ts";
import { analyzeLog } from "../src/triage/analysis.ts";
import { prepareLog } from "../src/triage/log.ts";
import { type TrimEngine, TrimRuntime, trimEnabled } from "../src/trim/runtime.ts";

const query = "Why did the checkout payment fail? Find the ledger error.";
function goldenInput(): string {
	let text = "$ kubectl logs deploy/checkout --since=1h\n";
	for (let i = 0; i < 400; i++) {
		text += `2026-10-11T03:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z INFO checkout request ${1000 + i} served in ${10 + (i % 17)}ms\n`;
		if (i === 271)
			text +=
				"2026-10-11T03:04:31Z ERROR payment client: ledger-db timeout after 30s (order 1271)\n    at LedgerClient.charge (ledger/client.go:88)\n";
	}
	return `${text}exit status 1\n`;
}
const text = goldenInput();
const signal = () => new AbortController().signal;

async function temporary(t: { after(fn: () => Promise<void>): void }): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "midnight-trim-test-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

function messages(name = "bash", args: unknown = { command: "npm test" }, output = text): LiveContextMessage[] {
	return [
		{ role: "user", content: query },
		{ role: "assistant", content: [{ type: "toolCall", id: "call", name, arguments: args }] },
		{ role: "toolResult", toolCallId: "call", toolName: name, content: [{ type: "text", text: output }] },
	];
}

function fakeEngine(kept = [273]): TrimEngine & { calls: number } {
	return {
		calls: 0,
		reset() {},
		async run() {
			this.calls++;
			return { status: "used", reason: "balanced", elapsedMs: 1, kept };
		},
	};
}

test("bundled WASM matches upstream golden selection and deterministically ranks locally", async (t) => {
	assert.equal(trimEnabled({}), true);
	assert.equal(trimEnabled({ MIDNIGHT_TRIM: "off" }), false);
	const engine = new TrimRuntime(true, 10000);
	t.after(() => engine.reset());
	const result = await engine.run(text, query, "trim", signal());
	assert.equal(result.status, "used", JSON.stringify(result));
	const lines = text.trimEnd().split("\n");
	const golden = (await readFile(new URL("../vendor/trim-1/testdata/golden.txt", import.meta.url), "utf8")).replaceAll(
		"\r\n",
		"\n",
	);
	const keep = new Set(result.kept);
	let output = "";
	for (let i = 0; i < lines.length; ) {
		if (keep.has(i)) output += `${lines[i++]}\n`;
		else {
			let end = i + 1;
			while (end < lines.length && !keep.has(end)) end++;
			const count = end - i;
			output += `… ${count} ${count === 1 ? "line" : "lines"} …\n`;
			i = end;
		}
	}
	assert.equal(output, golden);
	const first = await engine.run(text, query, "rank", signal());
	const second = await engine.run(text, query, "rank", signal());
	assert.equal(first.scores?.length, text.split("\n").length);
	assert.deepEqual(first.scores, second.scores);
	const model = await readFile(new URL("../vendor/trim-1/model.bin", import.meta.url));
	assert.equal(
		createHash("sha256").update(model).digest("hex"),
		"75478721d9992c3cbe6a1874ddf363ae6d78935a1fa526fb6fac1d0f6f3cdc2d",
	);
});

test("runtime guards, cancellation, timeout and missing assets safely preserve callers' fallback", async (t) => {
	const off = new TrimRuntime(false);
	assert.equal((await off.run(text, query, "trim", signal())).reason, "disabled");
	const engine = new TrimRuntime(true, 10000);
	t.after(() => engine.reset());
	assert.equal((await engine.run("tiny", query, "rank", signal())).status, "skipped");
	assert.equal((await engine.run(text, "", "rank", signal())).reason, "no_query");
	assert.equal((await engine.run("x\n".repeat(20000), query, "rank", signal())).reason, "line_limit");
	assert.equal((await engine.run(`${text}… 3 lines …`, query, "trim", signal())).reason, "already_trimmed");
	const controller = new AbortController();
	const pending = engine.run(text, query, "trim", controller.signal);
	assert.equal((await engine.run(text, query, "trim", signal())).reason, "busy");
	controller.abort();
	assert.equal((await pending).reason, "cancelled");
	const timeout = new TrimRuntime(true, 1);
	t.after(() => timeout.reset());
	assert.equal((await timeout.run(text, query, "rank", signal())).reason, "timeout");
	const missing = new TrimRuntime(true, 10000, new URL("./missing-trim-worker.mjs", import.meta.url));
	t.after(() => missing.reset());
	assert.equal((await missing.run(text, query, "rank", signal())).reason, "worker_unavailable");
});

test("untrusted worker scores and indices are validated", async (t) => {
	const dir = await temporary(t);
	for (const value of [{ scores: [2] }, { unchanged: false, kept: [-1] }, { unchanged: false, kept: [3, 1] }]) {
		const file = join(dir, "worker.mjs");
		await writeFile(
			file,
			`import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => parentPort.postMessage(${JSON.stringify(value)}));`,
		);
		const runtime = new TrimRuntime(true, 10000, pathToFileURL(file));
		assert.equal((await runtime.run(text, query, "scores" in value ? "rank" : "trim", signal())).status, "fallback");
		runtime.reset();
	}
});

test("triage ranks redacted lines before bounded selection and preserves explicit windows", async (t) => {
	const dir = await temporary(t);
	const lines = Array.from({ length: 650 }, (_, i) => `worker ${i}: normal progress output with enough padding`);
	lines[0] = "src/first.ts(1,1): error TS2322: Wrong type.";
	lines[200] = "dependency unavailable api_key=private-test-value";
	lines[649] = "finished with failure";
	await writeFile(join(dir, "build.log"), lines.join("\n"));
	let calls = 0;
	const engine: TrimEngine = {
		reset() {},
		async run(safe, focus) {
			calls++;
			assert.ok(!safe.includes("private-test-value"));
			assert.equal(focus, "dependency failure");
			return { status: "used", reason: "ranked", elapsedMs: 1, scores: lines.map((_, i) => (i === 200 ? 1 : 0)) };
		},
	};
	const result = await prepareLog(
		dir,
		{ path: "build.log", maxLines: 40, query: "dependency failure" },
		"",
		signal(),
		dir,
		engine,
	);
	assert.ok(result.text.includes("201: dependency unavailable"));
	assert.ok(result.text.includes("1: src/first.ts"));
	assert.ok(result.text.includes("650: finished"));
	assert.ok(result.selectedLineCount <= 40);
	assert.ok(Buffer.byteLength(result.text) <= 24 * 1024);
	assert.equal(result.trim?.status, "used");
	assert.equal(createHash("sha256").update(result.text).digest("hex"), result.selectionSha256);
	assert.equal(await readFile(result.snapshot, "utf8"), lines.join("\n"));
	await prepareLog(dir, { path: "build.log", startLine: 200, maxLines: 10 }, "", signal(), dir, engine);
	assert.equal(calls, 1);
	const baseline = analyzeLog(lines, undefined, 40);
	const fallback: TrimEngine = {
		reset() {},
		async run() {
			return { status: "fallback", reason: "timeout", elapsedMs: 2 };
		},
	};
	const failed = await prepareLog(dir, { path: "build.log", maxLines: 40 }, "", signal(), dir, fallback);
	assert.deepEqual(failed.selectedRanges, baseline.selectedRanges);
	assert.equal(failed.trim?.reason, "timeout");
});

test("context trims only the model projection, protects errors/tail and snapshots exact CRLF/Unicode", async (t) => {
	const dir = await temporary(t);
	const engine = fakeEngine();
	const trimmer = new ContextTrimmer(engine);
	const source = text.replaceAll("\n", "\r\n").replace("request 1000", "request 界1000");
	const raw = messages("bash", { command: "npm test" }, source);
	const before = structuredClone(raw);
	const projected = await trimmer.apply(raw, dir);
	assert.deepEqual(raw, before);
	assert.equal(projected[0], raw[0]);
	const excerpt = (projected[2].content as { text: string }[])[0].text;
	assert.match(excerpt, /Midnight Trim-1/);
	assert.match(excerpt, /ledger-db timeout/);
	assert.match(excerpt, /exit status 1/);
	const hash = createHash("sha256").update(source).digest("hex");
	assert.equal(await readFile(join(dir, "trim", `${hash}.txt`), "utf8"), source);
	const again = await trimmer.apply([...raw, { role: "user", content: "Different next question" }], dir);
	assert.deepEqual(again[2], projected[2]);
	assert.equal(engine.calls, 1);
});

test("context eligibility excludes instructions, source, explicit reads, structured/mixed output and projection prefix", async (t) => {
	const dir = await temporary(t);
	const engine = fakeEngine();
	const trimmer = new ContextTrimmer(engine);
	for (const raw of [
		messages("read", { path: "src/file.ts" }),
		messages("read", { path: "AGENTS.md" }),
		messages("read", { path: "instructions.log" }),
		messages("read", { path: "build.log", offset: 1 }),
		messages("bash", { command: "cat src/file.ts" }),
		messages("codemode", {}),
		messages("bash", { command: "npm test" }, JSON.stringify({ log: text })),
	])
		assert.deepEqual(await trimmer.apply(raw, dir), raw);
	const structured = messages();
	structured[2].structuredContent = { log: text };
	assert.deepEqual(await trimmer.apply(structured, dir), structured);
	const image = messages();
	(image[2].content as unknown[]).push({ type: "image", data: "image" });
	assert.deepEqual(await trimmer.apply(image, dir), image);
	const protectedMessages = messages();
	assert.deepEqual(await trimmer.apply(protectedMessages, dir, 3), protectedMessages);
	assert.equal(engine.calls, 0);
	assert.notDeepEqual(
		await trimmer.apply(messages("read", { path: "build.log" }), dir),
		messages("read", { path: "build.log" }),
	);
});

test("context cancellation discards late work; failure to save a recovery snapshot leaves original intact", async (t) => {
	const dir = await temporary(t);
	let release: (() => void) | undefined;
	const engine: TrimEngine = {
		reset() {},
		async run() {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { status: "used", reason: "balanced", elapsedMs: 1, kept: [273] };
		},
	};
	const trimmer = new ContextTrimmer(engine);
	const raw = messages();
	const pending = trimmer.apply(raw, dir);
	trimmer.reset();
	release?.();
	assert.deepEqual(await pending, raw);
	const blocked = join(dir, "not-a-directory");
	await writeFile(blocked, "file");
	assert.deepEqual(await new ContextTrimmer(fakeEngine()).apply(raw, blocked), raw);
});
