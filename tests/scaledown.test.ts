import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { analyzeLog } from "../src/scaledown/analysis.ts";
import { API_BASE, CATEGORIES, ScaleDownClient } from "../src/scaledown/client.ts";
import { registerScaleDown, type ScaleDownStatus, TOOL_NAME } from "../src/scaledown/index.ts";
import { type LogSelection, MAX_INPUT_BYTES, prepareLog, redact } from "../src/scaledown/log.ts";
import { type TriageData, TriageSchema } from "../src/scaledown/result.ts";
import { triageCorpus } from "./fixtures/scaledown-corpus.ts";

const KEY = "test-only-key-not-a-real-credential";
const signal = () => new AbortController().signal;
const decisions = () => ({
	answers: {
		category: {
			type: "choice",
			choice: "test_failure",
			confidence: 1,
			probabilities: Object.fromEntries(Object.keys(CATEGORIES).map((key) => [key, key === "test_failure" ? 1 : 0])),
		},
	},
	usage: { input_tokens: 100, output_tokens: 1, cost: 0.000004 },
});
const summary = (finish = "stop") => ({
	choices: [
		{
			message: { content: JSON.stringify({ summary: "One assertion failed in test A.", finish_reason: finish }) },
			finish_reason: finish,
		},
	],
	usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 },
});
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

async function workspace(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "midnight-scaledown-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

test("log preparation snapshots exact original bytes, bounds selected lines, and preserves local line evidence", async (t) => {
	const root = await workspace(t);
	const text = Array.from({ length: 450 }, (_, index) => `${index === 440 ? "ERROR TS1234 " : "output "}${index}`).join(
		"\r\n",
	);
	await writeFile(join(root, "build.log"), text);
	const result = await prepareLog(root, { path: "build.log" }, KEY, signal(), root);
	assert.equal(result.startLine, 51);
	assert.equal(result.endLine, 450);
	assert.equal(result.totalLines, 450);
	assert.match(result.evidence, /441: ERROR TS1234 440/);
	assert.equal(await readFile(result.snapshot, "utf8"), text);
	assert.match(result.sha256, /^[a-f0-9]{64}$/);
	assert.ok(Buffer.byteLength(result.text) <= MAX_INPUT_BYTES);
	const range = await prepareLog(root, { path: "build.log", startLine: 440, maxLines: 3 }, KEY, signal(), root);
	assert.equal(range.startLine, 440);
	assert.equal(range.endLine, 442);
	assert.match(range.evidence, /441: ERROR/);
});

test("credential redaction stays local to the upload and preserves source line numbers", async (t) => {
	const root = await workspace(t);
	const text = `api_key=${KEY}\nAuthorization: Bearer abc.def.ghi\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\nERROR bad assertion\n`;
	await writeFile(join(root, "build.log"), text);
	const result = await prepareLog(root, { path: "build.log" }, KEY, signal(), root);
	assert.equal(result.redacted, true);
	assert.doesNotMatch(result.text, /abc\.def\.ghi|private-material|test-only-key/);
	assert.match(result.evidence, /6: ERROR bad assertion/);
	assert.equal(await readFile(result.snapshot, "utf8"), text);
	const middle = await prepareLog(root, { path: "build.log", startLine: 4, maxLines: 1 }, KEY, signal(), root);
	assert.equal(middle.text, "4: [REDACTED PRIVATE KEY]");
	assert.equal(middle.startLine, 4);
	assert.equal(redact("Cookie: session=abc; other=def", KEY), "Cookie: [REDACTED]");
	assert.doesNotMatch(redact("-----BEGIN PRIVATE KEY-----\ntruncated-key", KEY), /truncated-key/);
	assert.equal(
		redact("https://user:pass@example.com/ PASSWORD='hello'", KEY),
		"https://[REDACTED]@example.com/ PASSWORD=[REDACTED]",
	);
});

test("line and byte limits operate on whole UTF-8 lines, and explicit windows retain their start", async (t) => {
	const root = await workspace(t);
	await writeFile(
		join(root, "large.log"),
		Array.from({ length: 100 }, (_, i) => `${i} ${"界".repeat(1000)}`).join("\n"),
	);
	const tail = await prepareLog(root, { path: "large.log" }, KEY, signal(), root);
	assert.equal(tail.endLine, 100);
	assert.ok(tail.startLine > 90);
	assert.ok(Buffer.byteLength(tail.text) <= MAX_INPUT_BYTES);
	const head = await prepareLog(root, { path: "large.log", startLine: 1 }, KEY, signal(), root);
	assert.equal(head.startLine, 1);
	assert.ok(head.endLine < 10);
	await writeFile(join(root, "huge-line.log"), "x".repeat(MAX_INPUT_BYTES + 1));
	await assert.rejects(prepareLog(root, { path: "huge-line.log" }, KEY, signal(), root), /line exceeds/);
});

test("invalid, binary, oversized, sensitive, and out-of-project paths fail before upload", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "source.ts"), "code");
	await writeFile(join(root, ".env.local"), "SECRET=private");
	await writeFile(join(root, "empty.log"), "");
	await writeFile(join(root, "binary.log"), Buffer.from([0, 1]));
	await writeFile(join(root, "invalid.log"), Buffer.from([0xff]));
	await writeFile(join(root, "oversized.log"), Buffer.alloc(1024 * 1024 + 1, 65));
	await writeFile(join(root, "ok.log"), "ok\n");
	for (const path of [
		"source.ts",
		".env.local",
		"empty.log",
		"binary.log",
		"invalid.log",
		"oversized.log",
		"../outside.log",
	])
		await assert.rejects(prepareLog(root, { path }, KEY, signal(), root));
	for (const range of [{ startLine: 0 }, { startLine: 99 }, { maxLines: 401 }, { maxLines: 0 }])
		await assert.rejects(prepareLog(root, { path: "ok.log", ...range }, KEY, signal(), root));
	const aborted = new AbortController();
	aborted.abort();
	await assert.rejects(prepareLog(root, { path: "ok.log" }, KEY, aborted.signal, root), /abort/i);
});

test("symlinked directories cannot escape the project or hide a sensitive directory", async (t) => {
	const root = await workspace(t);
	const outside = await workspace(t);
	await writeFile(join(outside, "secret.log"), "private");
	await mkdir(join(root, ".pi"));
	await writeFile(join(root, ".pi", "private.log"), "private");
	await symlink(outside, join(root, "escape"), "junction");
	await symlink(join(root, ".pi"), join(root, "alias"), "junction");
	await assert.rejects(prepareLog(root, { path: "escape/secret.log" }, KEY, signal(), root), /symlinks/);
	await assert.rejects(prepareLog(root, { path: "alias/private.log" }, KEY, signal(), root), /symlinks/);
});

test("client uses pinned helper models, state.text, fixed HTTPS endpoints and non-streaming summary JSON", async () => {
	const calls: { url: string; options: RequestInit; body: Record<string, unknown> }[] = [];
	const client = new ScaleDownClient(async (url, options = {}) => {
		calls.push({ url: String(url), options, body: JSON.parse(String(options.body)) });
		return json(String(url).endsWith("/v1/scaledown") ? decisions() : summary());
	});
	const category = await client.classify("ERROR assertion", KEY, signal(), 1000);
	const result = await client.summarize("ERROR assertion", KEY, signal(), 1000);
	assert.deepEqual(category.value, { category: "test_failure", confidence: 1 });
	assert.equal(category.usage?.cost.total, 0.000004);
	assert.equal(category.costKnown, true);
	assert.deepEqual(result.value, { text: "One assertion failed in test A.", truncated: false });
	assert.equal(result.usage?.totalTokens, 140);
	assert.equal(result.costKnown, false);
	assert.equal(calls[0].url, `${API_BASE}/v1/scaledown`);
	assert.deepEqual(calls[0].body.state, { text: "ERROR assertion" });
	assert.equal(calls[0].body.model, "classify-1");
	assert.equal(calls[1].body.model, "summarize-1");
	assert.equal(calls[1].body.stream, false);
	assert.equal(calls[1].body.max_tokens, 512);
	for (const call of calls) {
		assert.equal(call.options.redirect, "error");
		assert.equal((call.options.headers as Record<string, string>)["x-api-key"], KEY);
		assert.ok(call.options.signal);
	}
});

test("malformed payloads preserve reported usage, and truncated summaries are marked", async () => {
	const invalid = summary();
	invalid.choices[0].message.content = "not JSON";
	const result = await new ScaleDownClient(async () => json(invalid)).summarize("log", KEY, signal(), 1000);
	assert.match(result.error ?? "", /invalid response/);
	assert.equal(result.usage?.input, 120);
	const truncated = await new ScaleDownClient(async () => json(summary("length"))).summarize(
		"log",
		KEY,
		signal(),
		1000,
	);
	assert.equal(truncated.value?.truncated, true);
	const wrong = decisions();
	wrong.answers.category.probabilities.test_failure = 5;
	const category = await new ScaleDownClient(async () => json(wrong)).classify("log", KEY, signal(), 1000);
	assert.equal(category.value, undefined);
	assert.equal(category.usage?.output, 1);
});

test("HTTP, malformed JSON, oversized responses, and fetch failures never leak response bodies or credentials", async () => {
	const cases: (() => Promise<Response>)[] = [
		async () => new Response(`server echoed ${KEY}`, { status: 429 }),
		async () => new Response(KEY),
		async () => new Response("x".repeat(70 * 1024)),
		async () => {
			throw new Error(KEY);
		},
	];
	for (const fetcher of cases) {
		let calls = 0;
		const result = await new ScaleDownClient(async () => {
			calls++;
			return fetcher();
		}).classify("log", KEY, signal(), 1000);
		assert.ok(result.error);
		assert.equal(result.value, undefined);
		assert.equal(calls, 1);
		assert.equal(result.costKnown, false);
		assert.ok(!JSON.stringify(result).includes(KEY));
	}
});

test("timeouts and caller cancellation abort the fetch without retrying", async () => {
	const client = new ScaleDownClient(
		async (_url, options) =>
			new Promise((_resolve, reject) => {
				options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
			}),
	);
	// AbortSignal.timeout uses an unref'd timer; hold the test alive until the request resolves.
	const hold = setTimeout(() => {}, 1000);
	try {
		const timed = await client.summarize("log", KEY, signal(), 10);
		assert.match(timed.error ?? "", /timed out/);
		const controller = new AbortController();
		const pending = client.classify("log", KEY, controller.signal, 1000);
		controller.abort();
		assert.match((await pending).error ?? "", /cancelled/);
	} finally {
		clearTimeout(hold);
	}
});

function harness(
	options: { flag?: boolean; accepted?: boolean; env?: NodeJS.ProcessEnv; fetcher?: typeof fetch; log?: string } = {},
) {
	let tool!: ToolDefinition;
	let active = ["read", "bash"];
	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const notices: string[] = [];
	const statuses: (ScaleDownStatus | undefined)[] = [];
	const requests: string[] = [];
	let reads = 0;
	let confirmations = 0;
	const pi = {
		registerTool: (value: ToolDefinition) => {
			tool = value;
		},
		registerFlag: () => {},
		getFlag: () => options.flag ?? false,
		getActiveTools: () => active,
		setActiveTools: (value: string[]) => {
			active = value;
		},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			events.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "project-A",
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: () => assert.fail("ScaleDown must not add footer status text"),
			confirm: async () => {
				confirmations++;
				return options.accepted ?? true;
			},
		},
	} as unknown as ExtensionContext;
	const integration = registerScaleDown(pi, {
		onUpdate: (status) => statuses.push(status),
		env: options.env ?? { SCALEDOWN_API_KEY: KEY },
		client: new ScaleDownClient(
			options.fetcher ??
				(async (url, init) => {
					requests.push(String(init?.body));
					return json(String(url).endsWith("/v1/scaledown") ? decisions() : summary());
				}),
		),
		prepare: async (cwd, args, _key, inputSignal) => {
			reads++;
			inputSignal.throwIfAborted();
			const lines = (options.log ?? "ERROR assertion").split("\n");
			const analysis = analyzeLog(lines, args.startLine, args.maxLines);
			return {
				...analysis,
				project: cwd,
				source: `${cwd}/${args.path}`,
				snapshot: `temp/original-${reads}.log`,
				sha256: "hash",
				selectionSha256: createHash("sha256").update(analysis.text).digest("hex"),
				startLine: analysis.selectedRanges[0].startLine,
				endLine: analysis.selectedRanges.at(-1)?.endLine ?? lines.length,
				totalLines: lines.length,
				redacted: false,
			};
		},
		now: (() => {
			let tick = 0;
			return () => ++tick;
		})(),
	});
	const emit = (name: string) => events.get(name)?.({}, ctx);
	emit("session_start");
	return {
		ctx,
		integration,
		emit,
		notices,
		statuses,
		requests,
		active: () => active,
		reads: () => reads,
		confirmations: () => confirmations,
		tool: () => tool,
		run: (runSignal?: AbortSignal, args: Partial<LogSelection> & { mode?: "auto" | "local" | "remote" } = {}) =>
			tool.execute(
				"test-call",
				{ path: "build.log", mode: "remote", ...args },
				runSignal,
				undefined,
				ctx as ExtensionToolContext,
			),
	};
}

test("helper stays inactive and performs no reads or network calls without explicit opt-in", async () => {
	const h = harness();
	assert.deepEqual(h.active(), ["read", "bash"]);
	await assert.rejects(h.run(), /ScaleDown is off/);
	assert.equal(h.reads(), 0);
	assert.equal(h.requests.length, 0);
	const declined = harness({ accepted: false });
	await declined.integration.command("on", declined.ctx);
	assert.equal(declined.confirmations(), 1);
	await assert.rejects(declined.run(), /off/);
	const missing = harness({ env: {}, flag: true });
	await missing.integration.command("on", missing.ctx);
	assert.equal(missing.confirmations(), 0);
	assert.match(missing.notices.at(-1) ?? "", /SCALEDOWN_API_KEY/);
});

test("enabled helper combines usage once and marks summary cost unknown, with no changes to the coding model", async () => {
	const h = harness();
	await h.integration.command("on", h.ctx);
	assert.deepEqual(h.active(), ["read", "bash", TOOL_NAME]);
	const result = await h.run();
	assert.equal(h.requests.length, 2);
	assert.equal(result.usage?.input, 220);
	assert.equal(result.usage?.output, 21);
	assert.equal(result.usage?.cost.total, 0.000004);
	assert.equal(result.isError, false);
	assert.match(JSON.stringify(result.content), /unreported charges are not zero/);
	assert.match(JSON.stringify(result.content), /Local evidence/);
	assert.deepEqual(h.statuses.at(-1), {
		enabled: true,
		requests: 2,
		tokens: 241,
		incomplete: false,
		localCalls: 0,
		cacheHits: 0,
		lastCall: { mode: "remote", reason: "remote_requested", totalMs: 3, providerMs: 1, issues: false },
	});
	await h.integration.command("status", h.ctx);
	assert.match(h.notices.at(-1) ?? "", /cost incomplete/);
	await h.integration.command("off", h.ctx);
	assert.deepEqual(h.active(), ["read", "bash"]);
	await assert.rejects(h.run(), /off/);
});

test("request budget counts failures and cannot be reset by toggling on/off", async () => {
	let calls = 0;
	const h = harness({
		flag: true,
		env: { SCALEDOWN_API_KEY: KEY, SCALEDOWN_MAX_REQUESTS: "2" },
		fetcher: async () => {
			calls++;
			return new Response("failure", { status: 502 });
		},
	});
	const result = await h.run();
	assert.equal(result.isError, true);
	assert.equal(h.statuses.at(-1)?.lastCall?.issues, true);
	assert.match(JSON.stringify(result.content), /local evidence/i);
	assert.equal(result.usage, undefined);
	await h.integration.command("off", h.ctx);
	await h.integration.command("on", h.ctx);
	await assert.rejects(h.run(), /limit reached/);
	assert.equal(calls, 2);
	assert.equal(h.reads(), 2);
});

test("concurrent calls cannot overspend the request cap", async () => {
	const h = harness({ flag: true, env: { SCALEDOWN_API_KEY: KEY, SCALEDOWN_MAX_REQUESTS: "2" } });
	const results = await Promise.allSettled([h.run(), h.run()]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(h.requests.length, 2);
});

test("turning off while consent is pending prevents late approval from re-enabling uploads", async () => {
	const h = harness();
	let approve!: (accepted: boolean) => void;
	h.ctx.ui.confirm = async () =>
		new Promise<boolean>((resolve) => {
			approve = resolve;
		});
	const pending = h.integration.command("on", h.ctx);
	await h.integration.command("off", h.ctx);
	approve(true);
	await pending;
	await assert.rejects(h.run(), /off/);
	assert.equal(h.requests.length, 0);
});

test("one failed helper still returns the other result and its usage", async () => {
	const h = harness({
		flag: true,
		fetcher: async (url) =>
			String(url).endsWith("/v1/scaledown") ? json(decisions()) : new Response("private", { status: 402 }),
	});
	const result = await h.run();
	assert.equal(result.isError, false);
	assert.equal(result.usage?.input, 100);
	assert.match(JSON.stringify(result.content), /No generated summary/);
	assert.match(JSON.stringify(result.content), /HTTP 402/);
	assert.equal(h.statuses.at(-1)?.lastCall?.issues, true);
});

test("persistent user opt-in enables explicit helpers across projects without confirmation", async () => {
	const h = harness({ env: { SCALEDOWN_API_KEY: KEY, SCALEDOWN_ENABLED: "1" } });
	assert.ok(h.active().includes(TOOL_NAME));
	assert.equal(h.confirmations(), 0);
	assert.equal(h.requests.length, 0);
	await h.run();
	await h.integration.command("off", h.ctx);
	await assert.rejects(h.run(), /off/);
	Object.assign(h.ctx, { cwd: "project-B", mode: "print", hasUI: false });
	h.emit("session_start");
	assert.ok(h.active().includes(TOOL_NAME));
	await h.run();
	assert.equal(h.confirmations(), 0);
	const disabled = harness({ env: { SCALEDOWN_API_KEY: KEY, SCALEDOWN_ENABLED: "0" } });
	await assert.rejects(disabled.run(), /off/);
	const missingKey = harness({ env: { SCALEDOWN_ENABLED: "1" } });
	await assert.rejects(missingKey.run(), /off/);
});

test("CLI consent is scoped to the starting project; print/RPC do not require panel UI", async () => {
	const h = harness({ flag: true });
	Object.assign(h.ctx, { mode: "print", hasUI: false });
	await h.run();
	const count = h.statuses.length;
	Object.assign(h.ctx, { cwd: "project-B" });
	h.emit("session_start");
	assert.equal(h.statuses.length, count);
	await assert.rejects(h.run(), /off/);
	await h.integration.command("on", h.ctx);
	assert.match(h.notices.at(-1) ?? "", /--midnight-scaledown/);
});

test("session replacement and shutdown abort in-flight calls and discard stale status updates", async () => {
	for (const event of ["session_start", "session_shutdown"]) {
		const entered: AbortSignal[] = [];
		const h = harness({
			flag: true,
			fetcher: async (_url, init) =>
				new Promise((_resolve, reject) => {
					const requestSignal = init?.signal as AbortSignal;
					entered.push(requestSignal);
					requestSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		});
		const pending = h.run();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(entered.length, 2);
		h.emit(event);
		const count = h.statuses.length;
		const result = await pending;
		assert.equal(result.isError, true);
		assert.ok(entered.every((requestSignal) => requestSignal.aborted));
		assert.equal(h.statuses.length, count);
		assert.equal(h.integration.sidebarStatus()?.lastCall, undefined);
	}
});

function structured(result: Awaited<ReturnType<ReturnType<typeof harness>["run"]>>): TriageData {
	assert.ok(Value.Check(TriageSchema, result.structuredContent), "Tool output must match its declared schema");
	assert.deepEqual(result.details, result.structuredContent);
	return result.structuredContent as TriageData;
}

test("offline regression corpus preserves diagnostics, selected ranges, and honest local categories", () => {
	for (const fixture of triageCorpus) {
		const result = analyzeLog([...fixture.lines]);
		assert.equal(result.localCategory, fixture.category, fixture.name);
		assert.equal(result.diagnostics.length, fixture.groups, fixture.name);
		for (const code of fixture.codes) {
			assert.ok(
				result.diagnostics.some((item) => item.code === code),
				`${fixture.name}: ${code}`,
			);
			assert.ok(result.text.includes(code), `${fixture.name}: selected evidence must retain ${code}`);
		}
		assert.ok(Buffer.byteLength(result.text) <= MAX_INPUT_BYTES);
		assert.ok(result.selectedLineCount <= 400);
		const covered = new Set<number>();
		for (const range of [...result.selectedRanges, ...result.omittedRanges]) {
			for (let line = range.startLine; line <= range.endLine; line++) {
				assert.ok(!covered.has(line));
				covered.add(line);
			}
		}
		assert.equal(covered.size, fixture.lines.length);
	}
	const repeated = analyzeLog([...triageCorpus[1].lines]);
	assert.ok(repeated.selectedLineCount < 20, "repeated diagnostics must not fill the upload budget");
	assert.equal(repeated.diagnostics[0].occurrences, 500);
	assert.equal(repeated.diagnostics[0].lastLine, 500);
	assert.ok(repeated.evidence.includes("ERESOLVE"));
	assert.equal(analyzeLog([...triageCorpus[3].lines]).localReason, "reported_test_totals");
	assert.equal(analyzeLog([...triageCorpus[4].lines]).localReason, null);
});

test("large scans and explicit windows report omissions without claiming whole-log success", () => {
	const lines = [...triageCorpus[0].lines];
	const result = analyzeLog(lines, undefined, 12);
	assert.ok(result.selectedRanges.some((range) => range.startLine === 1));
	assert.ok(result.selectedRanges.some((range) => range.endLine === lines.length));
	assert.ok(result.omittedRanges.length);
	const window = analyzeLog(lines, 590, 3);
	assert.deepEqual(window.scannedRange, { startLine: 590, endLine: 592 });
	assert.deepEqual(window.selectedRanges, [window.scannedRange]);
	assert.equal(window.localCategory, null);
	assert.equal(window.diagnostics.length, 0);
	const incomplete = [...triageCorpus[3].lines].filter((line) => !line.includes("duration_ms"));
	assert.equal(analyzeLog(incomplete).localReason, null);
	assert.equal(analyzeLog([...triageCorpus[3].lines], undefined, 1).localReason, null);
	assert.equal(analyzeLog(["npm error code ELIFECYCLE"]).localCategory, null);
	const failed = [...triageCorpus[3].lines].map((line) => (line === "ℹ fail 0" ? "ℹ fail 1" : line));
	assert.equal(analyzeLog(failed).localCategory, null);
	const many = analyzeLog(Array.from({ length: 100 }, (_, i) => `src/${i}.ts(1,1): error TS2304: Missing name.`));
	assert.ok(many.diagnosticsOmitted > 0);
	assert.equal(many.localReason, null);
});

test("multi-range evidence redacts secrets before selection and hashes the exact numbered upload", async (t) => {
	const root = await workspace(t);
	const text = `ERROR token=${KEY}\n${"progress\n".repeat(500)}ERROR final assertion`;
	await writeFile(join(root, "build.log"), text);
	const log = await prepareLog(root, { path: "build.log", maxLines: 12 }, KEY, signal(), root);
	assert.ok(log.selectedRanges.length > 1);
	assert.ok(log.text.includes("1: ERROR token=[REDACTED]"));
	assert.ok(log.text.includes("502: ERROR final assertion"));
	assert.doesNotMatch(JSON.stringify([log.text, log.evidence, log.diagnostics]), /test-only-key/);
	assert.equal(log.selectionSha256, createHash("sha256").update(log.text).digest("hex"));
	assert.equal(await readFile(log.snapshot, "utf8"), text);
});

test("auto/local gates return schema-valid evidence with no network or invented process status", async () => {
	for (const log of ["ERROR assertion", triageCorpus[0].lines.join("\n"), triageCorpus[3].lines.join("\n")]) {
		const h = harness({ flag: true, log });
		assert.deepEqual(h.tool().outputSchema, TriageSchema);
		const result = await h.run(undefined, { mode: "auto" });
		const data = structured(result);
		assert.equal(data.mode, "local");
		assert.equal(data.exitCode, null);
		assert.equal(data.requestAttempts, 0);
		assert.equal(data.reportedCostUsd, 0);
		assert.equal(result.usage, undefined);
		assert.equal(h.requests.length, 0);
		assert.equal(data.providerMs, 0);
		assert.ok(data.totalMs > 0);
		assert.equal(h.statuses.at(-1)?.localCalls, 1);
		assert.equal(h.statuses.at(-1)?.lastCall?.mode, "local");
	}
	const h = harness({ flag: true, log: triageCorpus[4].lines.join("\n") });
	const data = structured(await h.run(undefined, { mode: "local" }));
	assert.equal(data.reason, "local_requested");
	assert.equal(data.category, null);
	assert.equal(h.requests.length, 0);
	const remote = structured(await h.run(undefined, { mode: "auto" }));
	assert.equal(remote.mode, "remote");
	assert.equal(remote.reason, "no_local_match");
	assert.equal(remote.requestAttempts, 2);
	assert.ok(remote.providerMs > 0);
	assert.ok(remote.totalMs >= remote.providerMs);
});

test("successful cache hits refresh snapshots without re-billing and work after the cap is reached", async () => {
	const h = harness({ flag: true, env: { SCALEDOWN_API_KEY: KEY, SCALEDOWN_MAX_REQUESTS: "2" } });
	const first = structured(await h.run());
	const result = await h.run();
	const cached = structured(result);
	assert.equal(cached.mode, "cache");
	assert.equal(cached.summary, first.summary);
	assert.notEqual(cached.snapshot, first.snapshot);
	assert.equal(cached.requestAttempts, 0);
	assert.equal(cached.reportedTokens, 0);
	assert.equal(cached.reportedCostUsd, 0);
	assert.equal(cached.providerMs, 0);
	assert.equal(result.usage, undefined);
	assert.equal(h.requests.length, 2);
	assert.equal(h.statuses.at(-1)?.tokens, 241);
	assert.equal(h.statuses.at(-1)?.cacheHits, 1);
	assert.equal(h.statuses.at(-1)?.lastCall?.mode, "cache");
	assert.equal(h.statuses.at(-1)?.lastCall?.providerMs, 0);
	await h.integration.command("status", h.ctx);
	assert.match(h.notices.at(-1) ?? "", /1 cache hits/);
	const local = structured(await h.run(undefined, { mode: "local" }));
	assert.equal(local.mode, "local");
	await assert.rejects(h.run(undefined, { path: "other.log" }), /limit reached/);
});

test("cache identity includes project, source, redacted content, and selection settings; off/reload clear it", async () => {
	const options = { flag: true, log: "ERROR one" };
	const h = harness(options);
	await h.run();
	assert.equal(structured(await h.run()).mode, "cache");
	assert.equal(structured(await h.run(undefined, { maxLines: 30 })).mode, "remote");
	options.log = "ERROR two";
	assert.equal(structured(await h.run()).mode, "remote");
	Object.assign(h.ctx, { cwd: "project-B" });
	assert.equal(structured(await h.run()).mode, "remote");
	assert.equal(structured(await h.run(undefined, { path: "other.log" })).mode, "remote");
	await h.integration.command("off", h.ctx);
	await assert.rejects(h.run(), /off/);
	await h.integration.command("on", h.ctx);
	assert.equal(structured(await h.run()).mode, "remote");
	Object.assign(h.ctx, { cwd: "project-A" });
	h.emit("session_start");
	assert.equal(structured(await h.run()).mode, "remote");
});

test("cache is bounded and evicts the least recently used result", async () => {
	const h = harness({ flag: true, env: { SCALEDOWN_API_KEY: KEY, SCALEDOWN_MAX_REQUESTS: "100" } });
	for (let index = 0; index < 32; index++) await h.run(undefined, { path: `${index}.log` });
	assert.equal(structured(await h.run(undefined, { path: "0.log" })).mode, "cache");
	await h.run(undefined, { path: "32.log" });
	assert.equal(structured(await h.run(undefined, { path: "0.log" })).mode, "cache");
	assert.equal(structured(await h.run(undefined, { path: "1.log" })).mode, "remote");
});

test("partial, malformed, and truncated results are never cached; text and structured summaries are sanitized", async () => {
	for (const response of [
		() => new Response("private", { status: 502 }),
		() => json(summary("length")),
		() => json({}),
	]) {
		let calls = 0;
		const h = harness({
			flag: true,
			fetcher: async (url) => {
				calls++;
				return String(url).endsWith("/v1/scaledown") ? json(decisions()) : response();
			},
		});
		structured(await h.run());
		assert.equal(h.statuses.at(-1)?.lastCall?.issues, true);
		assert.equal(structured(await h.run()).mode, "remote");
		assert.equal(calls, 4);
	}
	const body = summary();
	body.choices[0].message.content = JSON.stringify({
		summary: `\u001b[31mERROR password=${KEY}`,
		finish_reason: "stop",
	});
	const h = harness({
		flag: true,
		fetcher: async (url) => json(String(url).endsWith("/v1/scaledown") ? decisions() : body),
	});
	for (let index = 0; index < 2; index++) {
		const result = await h.run();
		assert.doesNotMatch(JSON.stringify(result), /test-only-key|\\u001b/);
		assert.match(structured(result).summary ?? "", /REDACTED/);
	}
});

test("session changes while preparing prevent uploads, including local/cache delivery", async () => {
	const h = harness({ flag: true });
	await h.run();
	const pending = h.run();
	h.emit("session_start");
	await assert.rejects(pending, /abort/i);
	assert.equal(h.requests.length, 2);
});

test("status distinguishes authorization from use and retains local-only activity when disabled", async () => {
	const h = harness({ flag: true });
	await h.integration.command("status", h.ctx);
	assert.match(h.notices.at(-1) ?? "", /explicit calls only; no automatic uploads/);
	assert.match(h.notices.at(-1) ?? "", /Not used since session start\/reload/);
	assert.equal(h.requests.length, 0);
	await h.run(undefined, { mode: "auto" });
	await h.integration.command("off", h.ctx);
	assert.equal(h.integration.sidebarStatus()?.enabled, false);
	assert.equal(h.integration.sidebarStatus()?.localCalls, 1);
	await h.integration.command("status", h.ctx);
	assert.match(h.notices.at(-1) ?? "", /Last result: local · short_selection/);
	assert.match(h.notices.at(-1) ?? "", /0 ms provider wait/);
	assert.equal(h.requests.length, 0);
	h.emit("session_start");
	assert.equal(h.integration.sidebarStatus()?.localCalls, 0);
	assert.equal(h.integration.sidebarStatus()?.lastCall, undefined);
});

test("turning off an in-flight request does not publish it as the last result", async () => {
	const h = harness({
		flag: true,
		fetcher: async (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
	});
	const pending = h.run();
	await new Promise((resolve) => setImmediate(resolve));
	await h.integration.command("off", h.ctx);
	await pending;
	assert.equal(h.integration.sidebarStatus()?.requests, 2);
	assert.equal(h.integration.sidebarStatus()?.lastCall, undefined);
	assert.equal(h.integration.sidebarStatus()?.enabled, false);
});

test("bad limits and cancelled calls fail before reading or uploading", async () => {
	const h = harness({ flag: true, env: { SCALEDOWN_API_KEY: KEY, SCALEDOWN_MAX_REQUESTS: "NaN" } });
	await assert.rejects(h.run(), /SCALEDOWN_MAX_REQUESTS/);
	assert.equal(h.reads(), 0);
	const cancelled = harness({ flag: true });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(cancelled.run(controller.signal), /abort/i);
	assert.equal(cancelled.requests.length, 0);
});
