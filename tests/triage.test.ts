import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { analyzeLog } from "../src/triage/analysis.ts";
import { emptyUsage, resolveHelper, TriageClient } from "../src/triage/client.ts";
import { registerTriage, TOOL_NAME, type TriageStatus } from "../src/triage/index.ts";
import { type LogSelection, MAX_INPUT_BYTES, prepareLog, redact } from "../src/triage/log.ts";
import { type TriageData, TriageSchema } from "../src/triage/result.ts";
import { triageCorpus } from "./fixtures/triage-corpus.ts";

const KEY = "test-only-key-not-a-real-credential";
const signal = () => new AbortController().signal;
const model: Model<Api> = {
	provider: "mock",
	id: "small",
	name: "Small",
	api: "openai-completions",
	baseUrl: "https://mock.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 32768,
	maxTokens: 4096,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
};
function reply(
	text = JSON.stringify({ category: "test_failure", summary: "Line 1: One assertion failed in test A." }),
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	const usage = emptyUsage();
	Object.assign(usage, { input: 100, output: 20, cacheRead: 4, cacheWrite: 2, totalTokens: 126 });
	usage.cost = { input: 0.0001, output: 0.00004, cacheRead: 0.000001, cacheWrite: 0.000002, total: 0.000143 };
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: 1,
		stopReason,
		usage,
	};
}
async function workspace(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "midnight-triage-test-"));
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

function harness(
	options: {
		flag?: boolean;
		env?: NodeJS.ProcessEnv;
		log?: string;
		accepted?: boolean;
		selected?: string;
		beforeDialog?: () => boolean;
		respond?: (signal: AbortSignal) => Promise<AssistantMessage>;
		prepareHook?: () => void;
		models?: Model<Api>[];
		auth?: boolean;
	} = {},
) {
	let tool!: ToolDefinition;
	let active = ["read", "bash"];
	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const notices: string[] = [];
	const statuses: (TriageStatus | undefined)[] = [];
	type Stream = ExtensionContext["modelRegistry"]["streamSimple"];
	const requests: Parameters<Stream>[] = [];
	let reads = 0;
	let confirmations = 0;
	const selections: Parameters<ExtensionContext["ui"]["select"]>[] = [];
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
		model: { ...model, id: "main" },
		modelRegistry: {
			getModelsOfType: () => options.models ?? [model],
			getModelOfType: (_type: string, provider: string, id: string) =>
				(options.models ?? [model]).find((m) => m.provider === provider && m.id === id),
			hasConfiguredAuth: () => options.auth ?? true,
			streamSimple: (...args: Parameters<Stream>) => {
				requests.push(args);
				return {
					result: () => (options.respond ? options.respond(args[2]?.signal as AbortSignal) : Promise.resolve(reply())),
				};
			},
		},
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: () => assert.fail("Triage must not add footer status text"),
			select: async (...args: Parameters<ExtensionContext["ui"]["select"]>) => {
				selections.push(args);
				return options.selected;
			},
			confirm: async () => {
				confirmations++;
				return options.accepted ?? true;
			},
		},
	} as unknown as ExtensionContext;
	const integration = registerTriage(pi, {
		onUpdate: (status) => statuses.push(status),
		beforeDialog: options.beforeDialog,
		env: options.env ?? { MIDNIGHT_TRIAGE_MODEL: "mock/small" },
		prepare: async (cwd, args, _key, inputSignal) => {
			reads++;
			inputSignal.throwIfAborted();
			options.prepareHook?.();
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
		selections,
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
function structured(result: Awaited<ReturnType<ReturnType<typeof harness>["run"]>>): TriageData {
	assert.ok(Value.Check(TriageSchema, result.structuredContent), "Tool output must match declared schema");
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

test("local triage needs no key, upload opt-in, or configured provider; old ScaleDown consent is ignored", async () => {
	const h = harness({ env: { SCALEDOWN_ENABLED: "1", SCALEDOWN_API_KEY: KEY }, log: triageCorpus[4].lines.join("\n") });
	assert.ok(h.active().includes(TOOL_NAME));
	assert.equal(h.tool().defaultActive, true);
	for (const mode of ["auto", "local", "remote"] as const) {
		const result = structured(await h.run(undefined, { mode }));
		assert.equal(result.mode, "local");
		assert.equal(result.exitCode, null);
		assert.equal(result.requestAttempts, 0);
		assert.equal(result.reportedCostUsd, 0);
	}
	assert.equal(h.requests.length, 0);
	assert.equal(h.confirmations(), 0);
	await h.integration.command("off", h.ctx);
	assert.equal(structured(await h.run(undefined, { mode: "local" })).mode, "local");
});

test("one selected chat request combines category and summary without changing the main model", async () => {
	const h = harness({ flag: true });
	const result = await h.run();
	const data = structured(result);
	assert.equal(h.requests.length, 1);
	assert.equal(data.requestAttempts, 1);
	assert.equal(h.requests[0][0], model);
	assert.equal(h.ctx.model?.id, "main");
	assert.equal(h.requests[0][2]?.maxRetries, 0);
	assert.equal(h.requests[0][2]?.maxTokens, 768);
	assert.deepEqual(h.requests[0][1].messages.length, 1);
	assert.match(h.requests[0][1].systemPrompt ?? "", /untrusted data/);
	assert.equal(data.category, "test_failure");
	assert.equal(data.confidence, null);
	assert.equal(data.reportedTokens, 126);
	assert.equal(data.costBasis, "catalog_estimate");
	assert.equal(data.reportedCostUsd, 0.000143);
	assert.equal(data.helperModel, "mock/small");
	assert.deepEqual(result.usage, reply().usage);
	assert.equal(h.statuses.at(-1)?.tokens, 126);
	assert.ok(data.providerMs > 0);
	assert.ok(data.totalMs >= data.providerMs);
});

test("auto gates avoid provider calls even when authorized", async () => {
	for (const log of ["ERROR assertion", triageCorpus[0].lines.join("\n"), triageCorpus[3].lines.join("\n")]) {
		const h = harness({ flag: true, log });
		const data = structured(await h.run(undefined, { mode: "auto" }));
		assert.equal(data.mode, "local");
		assert.equal(data.requestAttempts, 0);
		assert.equal(data.providerMs, 0);
		assert.equal(data.exitCode, null);
		assert.equal(h.requests.length, 0);
		assert.equal(h.statuses.at(-1)?.localCalls, 1);
	}
	const h = harness({ flag: true, log: triageCorpus[4].lines.join("\n") });
	assert.equal(structured(await h.run(undefined, { mode: "auto" })).reason, "no_local_match");
});

test("selection rejects non-chat, virtual, missing, and unauthenticated models; no guessed fallback", async () => {
	const h = harness({ env: {} });
	for (const name of ["small", "mock/", "mock/classifier", "unknown/small"])
		assert.throws(() => resolveHelper(h.ctx, name));
	const virtual = harness({ models: [{ ...model, api: "pi-virtual" }] });
	assert.throws(() => resolveHelper(virtual.ctx, "mock/small"), /physical/);
	const noAuth = harness({ flag: true, auth: false });
	assert.throws(() => resolveHelper(noAuth.ctx, "mock/small"), /authentication/);
	assert.equal(structured(await noAuth.run()).reason, "helper_unavailable");
	assert.equal(noAuth.requests.length, 0);
	await h.integration.command("on", h.ctx);
	assert.equal(h.confirmations(), 0);
	await h.integration.command("model mock/small", h.ctx);
	assert.equal(h.integration.sidebarStatus(), undefined);
	await h.integration.command("on", h.ctx);
	assert.equal(h.confirmations(), 1);
	assert.equal(structured(await h.run()).mode, "remote");
});

test("bare model opens a native helper picker; choosing revokes uploads but preserves budget and coding model", async () => {
	const h = harness({
		flag: true,
		selected: "mock/tiny",
		models: [
			model,
			{ ...model, id: "tiny" },
			{ ...model, id: "router", api: "pi-virtual" },
			{ ...model, id: "no-auth" },
		],
	});
	h.ctx.modelRegistry.hasConfiguredAuth = (selected) => selected.id !== "no-auth";
	await h.run();
	await h.integration.command("model", h.ctx);
	assert.equal(h.selections.length, 1);
	assert.deepEqual(h.selections[0][1], ["mock/small", "mock/tiny"]);
	assert.match(h.selections[0][0], /uploads stay off/);
	assert.ok(h.selections[0][2]?.signal);
	assert.equal(h.integration.active, false);
	assert.equal(h.ctx.model?.id, "main");
	assert.equal(h.confirmations(), 0);
	assert.equal(h.requests.length, 1, "Picker makes no provider calls");
	assert.equal(h.integration.sidebarStatus()?.requests, 1);
	assert.equal(h.integration.sidebarStatus()?.enabled, false);
	assert.equal(structured(await h.run()).mode, "local");
	await h.integration.command("on", h.ctx);
	assert.equal(structured(await h.run()).mode, "remote", "Choosing clears old cache");
	assert.equal(h.requests.at(-1)?.[0].id, "tiny");
});

test("picker cancellation and unexpected responses leave model, consent, cache and budget unchanged", async () => {
	for (const selected of [undefined, "mock/not-offered"]) {
		const h = harness({ flag: true, selected });
		await h.run();
		const before = h.integration.sidebarStatus();
		await h.integration.command("model", h.ctx);
		assert.deepEqual(h.integration.sidebarStatus(), before);
		assert.equal(h.integration.active, false);
		assert.equal(structured(await h.run()).mode, "cache");
		assert.equal(h.requests.length, 1);
		assert.equal(h.confirmations(), 0);
		await h.integration.command("status", h.ctx);
		assert.match(h.notices.at(-1) ?? "", /chat helper mock\/small/);
	}
});

test("picker handles empty catalogs, absent auth, unavailable UI, and RPC without guesses", async () => {
	for (const options of [{ models: [] }, { auth: false }]) {
		const h = harness(options);
		await h.integration.command("model", h.ctx);
		assert.equal(h.selections.length, 0);
		assert.match(h.notices.at(-1) ?? "", /No chat models/);
	}
	for (const mode of ["print", "json"]) {
		const h = harness({ selected: "mock/small" });
		Object.assign(h.ctx, { hasUI: false, mode });
		await h.integration.command("model", h.ctx);
		assert.equal(h.selections.length, 0);
		assert.match(h.notices.at(-1) ?? "", /requires interactive UI/);
		await h.integration.command("model mock/small", h.ctx);
		assert.match(h.notices.at(-2) ?? "", /Selected mock\/small/);
	}
	const rpc = harness({ selected: "mock/small" });
	Object.assign(rpc.ctx, { mode: "rpc" });
	await rpc.integration.command("model", rpc.ctx);
	assert.equal(rpc.selections.length, 1);
	assert.equal(rpc.requests.length, 0);
});

test("picker yields input ownership and blocks overlapping picker/consent dialogs", async () => {
	const blocked = harness({ beforeDialog: () => false });
	await blocked.integration.command("model", blocked.ctx);
	await blocked.integration.command("on", blocked.ctx);
	assert.equal(blocked.selections.length, 0);
	assert.equal(blocked.confirmations(), 0);
	assert.match(blocked.notices.at(-1) ?? "", /current Midnight dialog/);
	let prepared = 0;
	const h = harness({
		beforeDialog: () => {
			prepared++;
			return true;
		},
	});
	let finish!: (selected: string | undefined) => void;
	let opened = 0;
	h.ctx.ui.select = () => {
		opened++;
		return new Promise((resolve) => {
			finish = resolve;
		});
	};
	const pending = h.integration.command("model", h.ctx);
	assert.equal(h.integration.active, true);
	await h.integration.command("model", h.ctx);
	await h.integration.command("on", h.ctx);
	assert.equal(opened, 1);
	assert.equal(prepared, 1);
	assert.equal(h.confirmations(), 0);
	finish(undefined);
	await pending;
	assert.equal(h.integration.active, false);
});

test("session changes, tree navigation, shutdown and disable abort pickers and reject stale selections", async () => {
	for (const event of ["session_start", "session_tree", "session_shutdown", "off"] as const) {
		const h = harness({ models: [model, { ...model, id: "tiny" }] });
		let finish!: (selected: string) => void;
		let pickerSignal!: AbortSignal;
		h.ctx.ui.select = (_title, _labels, options) => {
			pickerSignal = options?.signal as AbortSignal;
			return new Promise((resolve) => {
				finish = resolve;
			});
		};
		const pending = h.integration.command("model", h.ctx);
		if (event === "off") await h.integration.command("off", h.ctx);
		else h.emit(event);
		assert.equal(pickerSignal.aborted, true);
		finish("mock/tiny");
		await pending;
		assert.equal(h.integration.active, false);
		assert.equal(h.requests.length, 0);
		assert.ok(!h.notices.some((notice) => notice.includes("Selected mock/tiny")));
	}
});

test("picker revalidates changed authentication and releases active state after UI errors", async () => {
	const h = harness();
	h.ctx.ui.select = async () => {
		h.ctx.modelRegistry.hasConfiguredAuth = () => false;
		return "mock/small";
	};
	await h.integration.command("model", h.ctx);
	assert.equal(h.integration.active, false);
	assert.match(h.notices.at(-1) ?? "", /authentication/);
	const failing = harness();
	failing.ctx.ui.select = async () => {
		throw new Error("UI failed");
	};
	await assert.rejects(failing.integration.command("model", failing.ctx), /UI failed/);
	assert.equal(failing.integration.active, false);
	assert.equal(failing.requests.length, 0);
});

test("cancelled consent cannot enable uploads; a model change requires new consent", async () => {
	const h = harness({ models: [model, { ...model, id: "tiny" }] });
	let finish!: (value: boolean) => void;
	h.ctx.ui.confirm = () =>
		new Promise((resolve) => {
			finish = resolve;
		});
	const pending = h.integration.command("on", h.ctx);
	await h.integration.command("off", h.ctx);
	finish(true);
	await pending;
	assert.equal(structured(await h.run()).mode, "local");
	h.ctx.ui.confirm = async () => true;
	await h.integration.command("on", h.ctx);
	await h.run();
	await h.integration.command("model mock/tiny", h.ctx);
	assert.equal(structured(await h.run()).mode, "local");
	await h.integration.command("on", h.ctx);
	await h.run();
	assert.equal(h.requests.at(-1)?.[0].id, "tiny");
});

test("persistent consent and startup flag are explicit; flag consent stays in starting project", async () => {
	const h = harness({ flag: true });
	Object.assign(h.ctx, { hasUI: false, mode: "rpc" });
	assert.equal(structured(await h.run()).mode, "remote");
	Object.assign(h.ctx, { cwd: "project-B" });
	h.emit("session_start");
	assert.equal(structured(await h.run()).mode, "local");
	await h.integration.command("on", h.ctx);
	assert.match(h.notices.at(-1) ?? "", /--midnight-triage/);
	const persistent = harness({ env: { MIDNIGHT_TRIAGE_MODEL: "mock/small", MIDNIGHT_TRIAGE_ENABLED: "1" } });
	Object.assign(persistent.ctx, { cwd: "project-B" });
	persistent.emit("session_start");
	assert.equal(structured(await persistent.run()).mode, "remote");
	assert.equal(persistent.confirmations(), 0);
	const noModel = harness({ env: { MIDNIGHT_TRIAGE_ENABLED: "1" } });
	assert.equal(structured(await noModel.run()).mode, "local");
});

test("budget reserves one request before awaiting, failures count, toggling cannot reset it", async () => {
	const h = harness({
		flag: true,
		env: { MIDNIGHT_TRIAGE_MODEL: "mock/small", MIDNIGHT_TRIAGE_MAX_REQUESTS: "1" },
		respond: async () => {
			throw new Error(KEY);
		},
	});
	const results = await Promise.allSettled([h.run(), h.run(undefined, { path: "other.log" })]);
	assert.equal(h.requests.length, 1);
	assert.equal(results[1].status, "rejected");
	if (results[0].status === "fulfilled") {
		const data = structured(results[0].value);
		assert.equal(data.completeCost, false);
		assert.equal(data.reportedTokens, null);
		assert.doesNotMatch(JSON.stringify(results[0].value), /test-only-key/);
	}
	await h.integration.command("off", h.ctx);
	await h.integration.command("on", h.ctx);
	await assert.rejects(h.run(), /limit reached/);
	assert.equal(structured(await h.run(undefined, { mode: "local" })).mode, "local");
});

test("successful cached results use fresh snapshots and no new usage, including after request cap", async () => {
	const h = harness({ flag: true, env: { MIDNIGHT_TRIAGE_MODEL: "mock/small", MIDNIGHT_TRIAGE_MAX_REQUESTS: "1" } });
	const first = structured(await h.run());
	const result = await h.run();
	const data = structured(result);
	assert.equal(data.mode, "cache");
	assert.notEqual(data.snapshot, first.snapshot);
	assert.equal(data.summary, first.summary);
	assert.equal(data.requestAttempts, 0);
	assert.equal(data.reportedTokens, 0);
	assert.equal(data.reportedCostUsd, 0);
	assert.equal(data.providerMs, 0);
	assert.equal(result.usage, undefined);
	assert.equal(h.statuses.at(-1)?.tokens, 126);
	assert.equal(h.requests.length, 1);
	assert.equal(h.statuses.at(-1)?.cacheHits, 1);
});

test("cache identity includes source, project, content, selection, model and endpoint; LRU stays bounded", async () => {
	const options = {
		flag: true,
		log: "ERROR one",
		env: { MIDNIGHT_TRIAGE_MODEL: "mock/small", MIDNIGHT_TRIAGE_MAX_REQUESTS: "100" },
		models: [{ ...model }],
	};
	const h = harness(options);
	await h.run();
	assert.equal(structured(await h.run()).mode, "cache");
	for (const args of [{ path: "other.log" }, { maxLines: 30 }, { startLine: 1 }])
		assert.equal(structured(await h.run(undefined, args)).mode, "remote");
	options.log = "ERROR two";
	assert.equal(structured(await h.run()).mode, "remote");
	Object.assign(h.ctx, { cwd: "project-B" });
	assert.equal(structured(await h.run()).mode, "remote");
	options.models[0].baseUrl = "https://another.invalid";
	assert.equal(structured(await h.run()).mode, "remote");
	await h.integration.command("off", h.ctx);
	await h.integration.command("on", h.ctx);
	assert.equal(structured(await h.run()).mode, "remote");
	h.emit("session_start");
	// Flag scoped to project A, so restarting in B removes its authorization.
	assert.equal(structured(await h.run()).mode, "local");
	Object.assign(h.ctx, { cwd: "project-A" });
	h.emit("session_start");
	for (let i = 0; i < 32; i++) await h.run(undefined, { path: `${i}.log` });
	assert.equal(structured(await h.run(undefined, { path: "0.log" })).mode, "cache");
	await h.run(undefined, { path: "32.log" });
	assert.equal(structured(await h.run(undefined, { path: "0.log" })).mode, "cache");
	assert.equal(structured(await h.run(undefined, { path: "1.log" })).mode, "remote");
});

test("malformed, truncated and failed output retains usage, never caches or leaks provider text", async () => {
	for (const response of [
		reply("private malformed"),
		reply("{}"),
		reply(JSON.stringify({ category: "wrong", summary: "bad" })),
		reply("x".repeat(66000)),
		reply(undefined, "length"),
		reply(undefined, "toolUse"),
	]) {
		const h = harness({ flag: true, respond: async () => response });
		const data = structured(await h.run());
		assert.equal(data.reportedTokens, 126);
		assert.equal(h.statuses.at(-1)?.lastCall?.issues, true);
		assert.equal(structured(await h.run()).mode, "remote");
		assert.equal(h.requests.length, 2);
		assert.doesNotMatch(data.errors.join(" "), /private malformed/);
	}
	const h = harness({
		flag: true,
		respond: async () => reply(JSON.stringify({ category: "runtime", summary: `\u001b[31mERROR password=${KEY}` })),
	});
	for (let i = 0; i < 2; i++) {
		const result = await h.run();
		assert.doesNotMatch(JSON.stringify(result), /test-only-key|\\u001b/);
		assert.match(structured(result).summary ?? "", /REDACTED/);
	}
});

test("zero model prices are unknown cost, not a free-call claim", async () => {
	const h = harness({
		flag: true,
		models: [{ ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		respond: async () => {
			const result = reply();
			result.usage.cost = emptyUsage().cost;
			return result;
		},
	});
	const data = structured(await h.run());
	assert.equal(data.reportedTokens, 126);
	assert.equal(data.reportedCostUsd, null);
	assert.equal(data.completeCost, false);
});

test("tokens survive unavailable costs; error defaults and malformed usage remain unknown", async () => {
	const missingCost = reply();
	Object.assign(missingCost.usage, { cost: undefined });
	const missingUsage = reply(undefined, "error");
	Object.assign(missingUsage, { usage: undefined, errorMessage: KEY });
	const zeroError = reply(undefined, "error");
	zeroError.usage = emptyUsage();
	const invalid = reply();
	invalid.usage.input = Number.NaN;
	for (const response of [missingCost, missingUsage, zeroError, invalid]) {
		const h = harness({ flag: true, respond: async () => response });
		const result = await h.run();
		const data = structured(result);
		assert.equal(data.reportedTokens, response === missingCost ? 126 : null);
		assert.equal(data.completeUsage, response === missingCost);
		assert.equal(data.reportedCostUsd, null);
		assert.equal(data.completeCost, false);
		assert.doesNotMatch(JSON.stringify(result), /test-only-key/);
		assert.equal(h.requests.length, 1);
	}
});

test("timeout, disable, model replacement, session replacement and shutdown discard in-flight output", async () => {
	for (const action of ["off", "model", "session_start", "session_shutdown"] as const) {
		let finish!: (value: AssistantMessage) => void;
		const h = harness({
			flag: true,
			respond: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		});
		const pending = h.run();
		await new Promise((resolve) => setImmediate(resolve));
		if (action === "off") await h.integration.command("off", h.ctx);
		else if (action === "model") await h.integration.command("model mock/small", h.ctx);
		else h.emit(action);
		finish(reply());
		const data = structured(await pending);
		assert.equal(data.summary, null);
		assert.notEqual(data.categorySource, "provider");
		assert.equal(data.reportedTokens, 126);
		assert.equal(h.integration.sidebarStatus()?.lastCall, undefined);
	}
	const h = harness({
		respond: async (inputSignal) =>
			new Promise((_resolve, reject) => {
				inputSignal.addEventListener("abort", () => reject(new Error(KEY)), { once: true });
			}),
	});
	const result = await new TriageClient().assess(h.ctx, model, "1: ambiguous", signal(), 10);
	assert.match(result.error ?? "", /timed out/);
	assert.equal(h.requests.length, 1);
	assert.equal(result.costKnown, false);
});

test("session changes while preparing block local/cache/remote delivery; canceled calls do not upload", async () => {
	const h = harness({ flag: true, prepareHook: () => h.emit("session_start") });
	await assert.rejects(h.run(), /abort/i);
	assert.equal(h.requests.length, 0);
	const cancelled = harness({ flag: true });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(cancelled.run(controller.signal), /abort/i);
	assert.equal(cancelled.requests.length, 0);
	const bad = harness({
		flag: true,
		env: { MIDNIGHT_TRIAGE_MODEL: "mock/small", MIDNIGHT_TRIAGE_MAX_REQUESTS: "NaN" },
	});
	await assert.rejects(bad.run(), /MIDNIGHT_TRIAGE_MAX_REQUESTS/);
	assert.equal(bad.reads(), 1);
	assert.equal(structured(await bad.run(undefined, { mode: "local" })).mode, "local");
	assert.equal(structured(await bad.run(undefined, { mode: "auto" })).mode, "local");
	await bad.integration.command("off", bad.ctx);
	assert.equal(structured(await bad.run()).mode, "local");
	assert.equal(bad.requests.length, 0);
});

test("status reports selected helper and local activity even with uploads off; reload resets usage", async () => {
	const h = harness();
	await h.integration.command("status", h.ctx);
	assert.match(h.notices.at(-1) ?? "", /chat helper mock\/small/);
	assert.match(h.notices.at(-1) ?? "", /Not used/);
	await h.run(undefined, { mode: "auto" });
	await h.integration.command("off", h.ctx);
	await h.integration.command("status", h.ctx);
	assert.match(h.notices.at(-1) ?? "", /Last result: local/);
	assert.equal(h.integration.sidebarStatus()?.localCalls, 1);
	assert.equal(h.integration.sidebarStatus()?.enabled, false);
	h.emit("session_start");
	assert.equal(h.integration.sidebarStatus(), undefined);
	await h.integration.command("models", h.ctx);
	assert.match(h.notices.at(-1) ?? "", /mock\/small/);
});
