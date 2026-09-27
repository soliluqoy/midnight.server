import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	compactReviewState,
	decisionBackendFromEnv,
	formatReviewFeedback,
	intakeNote,
	isLoopbackUrl,
	layaServeEnv,
	ManagedLaya,
	parseSystemOneResponse,
	REVIEW_QUESTIONS,
	REVIEW_STATE_CHARS,
	reviewPolicy,
	SystemOneClient,
} from "../src/harness/decisions.ts";

/**
 * A stand-in for `laya-serve`: the `/v1/systemone` protocol, `/health`, and the bearer key
 * from LAYA_API_KEY. It answers every noul with the probability in FAKE_NOUL.
 */
const FAKE_SERVER = `#!/usr/bin/env node
const http = require("node:http");
const key = process.env.LAYA_API_KEY;
http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		if (req.url === "/health") { res.writeHead(200); res.end("{}"); return; }
		if (key && req.headers.authorization !== "Bearer " + key) { res.writeHead(401); res.end("{}"); return; }
		const request = JSON.parse(body);
		const answers = {};
		for (const [name, q] of Object.entries(request.questions)) {
			if (q.type === "noul") answers[name] = { type: "noul", noul: Number(process.env.FAKE_NOUL ?? "0.9") };
			else if (q.type === "score") answers[name] = { type: "score", score: 2, confidence: 0.9, legend: {}, probabilities: { 0: 0, 1: 0.1, 2: 0.9 } };
			else answers[name] = { type: "choice", choice: Object.keys(q.criteria)[0], confidence: 0.9, probabilities: {} };
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ model: "laya-fake", answers, usage: { input_tokens: 42, output_tokens: 1 } }));
	});
}).listen(Number(process.env.LAYA_PORT), process.env.LAYA_HOST);
`;

describe("local decisions (Laya)", () => {
	it("accepts only loopback servers", () => {
		expect(isLoopbackUrl("http://127.0.0.1:8000")).toBe(true);
		expect(isLoopbackUrl("http://localhost:8000")).toBe(true);
		expect(isLoopbackUrl("http://[::1]:8000")).toBe(true);
		expect(isLoopbackUrl("https://decisions.example.com")).toBe(false);
		expect(isLoopbackUrl("http://10.0.0.5:8000")).toBe(false);
		expect(isLoopbackUrl("http://127.0.0.1.evil.com")).toBe(false);
		expect(() => new SystemOneClient({ baseUrl: "https://decisions.example.com" })).toThrow(/this machine/);
		expect(decisionBackendFromEnv({ MIDNIGHT_SERVER_LAYA_URL: "https://example.com" })).toBeUndefined();
		expect(
			decisionBackendFromEnv({ MIDNIGHT_SERVER_LAYA: "0", MIDNIGHT_SERVER_LAYA_URL: "http://127.0.0.1:1" }),
		).toBeUndefined();
		expect(decisionBackendFromEnv({ MIDNIGHT_SERVER_LAYA_URL: "http://127.0.0.1:1" })?.name).toBe("laya/auto");
	});

	it("preloads only the checkpoint in use when it starts laya-serve", () => {
		const env = layaServeEnv({ port: 4321, apiKey: "k", model: undefined, offline: false });
		expect(env).toMatchObject({
			LAYA_HOST: "127.0.0.1",
			LAYA_PORT: "4321",
			LAYA_API_KEY: "k",
			LAYA_MODELS: "english",
		});
		expect(env.HF_HUB_OFFLINE).toBeUndefined();
		expect(layaServeEnv({ port: 1, apiKey: "k", model: "multilingual", offline: true })).toMatchObject({
			LAYA_MODELS: "multilingual",
			HF_HUB_OFFLINE: "1",
		});
	});

	it("parses answers and drops unknown types", () => {
		const parsed = parseSystemOneResponse({
			model: "english",
			answers: {
				a: { type: "noul", noul: 0.2 },
				b: { type: "choice", choice: "x", confidence: 0.8, probabilities: { x: 0.8 } },
				c: { type: "future", value: 1 },
			},
			usage: { input_tokens: 10, output_tokens: 1 },
		});
		expect(Object.keys(parsed?.answers ?? {})).toEqual(["a", "b"]);
		expect(parsed?.inputTokens).toBe(10);
		expect(parseSystemOneResponse("nope")).toBeUndefined();
	});

	it("fits the review state into Laya's window with the request first", () => {
		const diff = [
			"diff --git a/port.js b/port.js",
			"--- a/port.js",
			"+++ b/port.js",
			"@@ -1,3 +1,5 @@",
			" function parsePort(value) {",
			"-\treturn Number(value);",
			"+\tconst port = Number(value);",
			...Array.from({ length: 400 }, (_, i) => `+\t// line ${i}`),
		].join("\n");
		const state = compactReviewState({
			request: "Make parsePort only return valid ports.",
			final_message: "Done. All tests pass.",
			change: { files: ["port.js"], checks: "[pass] unit", diff },
		});
		expect(Object.keys(state)).toEqual(["request", "final_message", "change"]);
		expect(JSON.stringify(state).length).toBeLessThan(REVIEW_STATE_CHARS + 400);
		expect(state.change.diff.startsWith("# port.js\n-\treturn Number(value);\n+\tconst port")).toBe(true);
		expect(state.change.diff).not.toContain("function parsePort");
	});

	it("asks for a revision only on confident negative judgments", () => {
		expect(reviewPolicy({ addresses_request: { type: "noul", noul: 0.6 } }).action).toBe("accept");
		const verdict = reviewPolicy({
			addresses_request: { type: "noul", noul: 0.1 },
			unsupported_claims: { type: "noul", noul: 0.95 },
			weakened_tests: { type: "noul", noul: 0.2 },
		});
		expect(verdict.action).toBe("revise");
		expect(verdict.reasons).toHaveLength(2);
		expect(formatReviewFeedback(verdict, "laya/auto")).toContain("addresses_request 10%");
		expect(Object.keys(REVIEW_QUESTIONS)).toEqual([
			"addresses_request",
			"unrelated_changes",
			"unsupported_claims",
			"weakened_tests",
		]);
		expect(intakeNote({ ambiguous: { type: "noul", noul: 0.9 } }).note).toContain("more than one way");
		expect(intakeNote({ ambiguous: { type: "noul", noul: 0.2 } }).note).toBeUndefined();
	});
});

describe.skipIf(process.platform === "win32")("managed laya-serve", () => {
	let bin: string;
	let savedPath: string | undefined;
	beforeEach(() => {
		bin = mkdtempSync(join(tmpdir(), "harness-laya-bin-"));
		writeFileSync(join(bin, "laya-serve"), FAKE_SERVER);
		chmodSync(join(bin, "laya-serve"), 0o755);
		savedPath = process.env.PATH;
		process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
	});
	afterEach(() => {
		process.env.PATH = savedPath;
		rmSync(bin, { recursive: true, force: true });
	});

	it("starts laya-serve on loopback with a per-session key, answers once healthy, and stops it", async () => {
		const backend = decisionBackendFromEnv({ PATH: process.env.PATH });
		expect(backend).toBeInstanceOf(ManagedLaya);
		const laya = backend as ManagedLaya;
		// Not started yet: no decision, never a default answer.
		expect(await laya.ask("x", { q: { type: "noul", instructions: "?" } })).toBeUndefined();
		await laya.start();
		expect(laya.status).toBe("ready");
		const result = await laya.ask("state", { q: { type: "noul", instructions: "Is it?" } });
		expect(result?.answers.q).toEqual({ type: "noul", noul: 0.9 });
		expect(result?.model).toBe("laya-fake");
		laya.dispose();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(await laya.ask("state", { q: { type: "noul", instructions: "Is it?" } })).toBeUndefined();
	}, 30_000);
});
