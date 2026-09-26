import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killProcessTree } from "../utils/shell.ts";

/**
 * Typed decisions around the session model, answered by Laya, an open-source System One model
 * (Apache 2.0, github.com/NandhaKishorM/laya) running on this machine.
 *
 * The generative model writes code; it should not also be the judge of whether its own work
 * is done. A System One model answers narrow typed questions about a state instead: a yes
 * probability (noul), one of a fixed set of labels (choice), or a level on an ordered rubric
 * (score), in one forward pass of a ~400M-parameter encoder. The harness asks a few such
 * questions where the answer changes what happens next, and code applies thresholds. A
 * favorable answer is evidence, never permission: it cannot override a failing check, and a
 * missing answer is treated as "no decision", not approval.
 *
 * Local only: requests go to `laya-serve` on the loopback interface, never to a remote host,
 * so the request and the diff do not leave the machine. `laya-serve` speaks the `/v1/systemone`
 * protocol:
 *   request  { state, model, questions: { name: { type, instructions?, criteria? } } }
 *   response { model, answers: { name: { type: "noul", noul } | { type: "choice", choice,
 *              confidence, probabilities } | { type: "score", score, confidence, legend,
 *              probabilities } }, usage: { input_tokens, output_tokens } }
 *
 * Configuration:
 * - `MIDNIGHT_SERVER_LAYA_URL`: a running server (loopback only); optional
 *   `MIDNIGHT_SERVER_LAYA_API_KEY` for it.
 * - Otherwise, when `laya-serve` is on PATH (`pip install "laya[serve]"`), the harness starts
 *   it on a random loopback port with a per-session key, and stops it with the session.
 * - `MIDNIGHT_SERVER_LAYA_MODEL`: checkpoint (`english`, `multilingual`, `typed-decisions`);
 *   default: the server picks per request.
 * - `MIDNIGHT_SERVER_LAYA=0` turns it off. In offline mode a started server never downloads.
 */

export type DecisionQuestion =
	| { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
	| { type: "choice"; instructions: string; criteria: Record<string, string | null> }
	| { type: "score"; instructions: string; criteria: string[] };

export type DecisionAnswer =
	| { type: "noul"; noul: number }
	| { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
	| { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

export interface DecisionResult {
	model: string;
	answers: Record<string, DecisionAnswer>;
	inputTokens: number;
	latencyMs: number;
}

export interface DecisionBackend {
	readonly name: string;
	ask(
		state: unknown,
		questions: Record<string, DecisionQuestion>,
		signal?: AbortSignal,
	): Promise<DecisionResult | undefined>;
	/** Begin any slow startup in the background (a managed server). */
	warmUp?(): void;
	dispose?(): void;
}

const REQUEST_TIMEOUT_MS = 20_000;

function isAnswer(value: unknown): value is DecisionAnswer {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (record.type === "noul") return typeof record.noul === "number";
	if (record.type === "choice") return typeof record.choice === "string" && typeof record.probabilities === "object";
	if (record.type === "score") return typeof record.score === "number" && typeof record.probabilities === "object";
	return false;
}

/** Parse a `/v1/systemone` response body. Unknown answer types are dropped, not fatal. */
export function parseSystemOneResponse(body: unknown): Omit<DecisionResult, "latencyMs"> | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const record = body as Record<string, unknown>;
	if (typeof record.answers !== "object" || record.answers === null) return undefined;
	const answers: Record<string, DecisionAnswer> = {};
	for (const [name, answer] of Object.entries(record.answers as Record<string, unknown>)) {
		if (isAnswer(answer)) answers[name] = answer;
	}
	const usage = record.usage as { input_tokens?: unknown } | undefined;
	return {
		model: typeof record.model === "string" ? record.model : "unknown",
		answers,
		inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : 0,
	};
}

/** True for URLs whose host is this machine. Anything else is refused: decisions stay local. */
export function isLoopbackUrl(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.replace(/^\[|\]$/g, "");
	} catch {
		return false;
	}
	return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** A `/v1/systemone` endpoint on this machine. */
export class SystemOneClient implements DecisionBackend {
	readonly name: string;
	private readonly baseUrl: string;
	private readonly apiKey: string | undefined;
	private readonly model: string;
	private readonly fetchImpl: FetchLike;

	constructor(options: { baseUrl: string; apiKey?: string; model?: string; fetch?: FetchLike }) {
		if (!isLoopbackUrl(options.baseUrl)) {
			throw new Error(`Decision server must be on this machine (loopback), got ${options.baseUrl}`);
		}
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.apiKey = options.apiKey;
		this.model = options.model ?? "auto";
		this.fetchImpl = options.fetch ?? fetch;
		this.name = `laya/${this.model}`;
	}

	async ask(
		state: unknown,
		questions: Record<string, DecisionQuestion>,
		signal?: AbortSignal,
	): Promise<DecisionResult | undefined> {
		const started = Date.now();
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
				},
				body: JSON.stringify({ state, model: this.model, questions }),
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
		} catch {
			return undefined;
		}
		if (!response.ok) return undefined;
		try {
			const result = parseSystemOneResponse(await response.json());
			return result ? { ...result, latencyMs: Date.now() - started } : undefined;
		} catch {
			return undefined;
		}
	}

	async healthy(signal?: AbortSignal): Promise<boolean> {
		try {
			const timeout = AbortSignal.timeout(3_000);
			const response = await this.fetchImpl(`${this.baseUrl}/health`, {
				method: "GET",
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
			return response.ok;
		} catch {
			return false;
		}
	}
}

async function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolvePort(port));
		});
	});
}

function onPath(command: string): boolean {
	return (
		spawnSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore", windowsHide: true })
			.status === 0
	);
}

function truthy(value: string | undefined): boolean {
	return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/**
 * A `laya-serve` process owned by this session: random loopback port, random bearer key,
 * killed with the session. It becomes usable once `/health` answers; until then `ask`
 * returns undefined (no decision), so a slow first start (model download, load) never blocks
 * the agent.
 */
export class ManagedLaya implements DecisionBackend {
	readonly name: string;
	private readonly model: string | undefined;
	private readonly offline: boolean;
	private child: ChildProcess | undefined;
	private client: SystemOneClient | undefined;
	private ready = false;
	private failed = false;
	private starting: Promise<void> | undefined;
	readonly logPath: string;

	constructor(options: { model?: string; offline: boolean }) {
		this.model = options.model;
		this.offline = options.offline;
		this.name = `laya/${options.model ?? "auto"} (local)`;
		this.logPath = join(tmpdir(), `midnight-laya-${process.pid}.log`);
	}

	/** Start the server in the background. Safe to call repeatedly. */
	start(): Promise<void> {
		this.starting ??= this.launch();
		return this.starting;
	}

	private async launch(): Promise<void> {
		try {
			const port = await freePort();
			const apiKey = randomBytes(24).toString("hex");
			const log = openSync(this.logPath, "a");
			this.child = spawn("laya-serve", [], {
				env: {
					...process.env,
					LAYA_HOST: "127.0.0.1",
					LAYA_PORT: String(port),
					LAYA_API_KEY: apiKey,
					LAYA_PRELOAD: "1",
					...(this.offline ? { HF_HUB_OFFLINE: "1" } : {}),
				},
				stdio: ["ignore", log, log],
				windowsHide: true,
			});
			closeSync(log);
			this.child.once("exit", () => {
				this.ready = false;
				this.failed = true;
			});
			this.client = new SystemOneClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey, model: this.model });
			// First start may download and load the checkpoint; allow up to 15 minutes.
			const deadline = Date.now() + 15 * 60_000;
			while (!this.failed && Date.now() < deadline) {
				if (await this.client.healthy()) {
					this.ready = true;
					return;
				}
				await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
			}
			this.failed = true;
		} catch {
			this.failed = true;
		}
	}

	warmUp(): void {
		void this.start();
	}

	get status(): "starting" | "ready" | "failed" {
		return this.ready ? "ready" : this.failed ? "failed" : "starting";
	}

	async ask(
		state: unknown,
		questions: Record<string, DecisionQuestion>,
		signal?: AbortSignal,
	): Promise<DecisionResult | undefined> {
		void this.start();
		if (!this.ready || !this.client) return undefined;
		return this.client.ask(state, questions, signal);
	}

	dispose(): void {
		if (this.child?.pid && this.child.exitCode === null) killProcessTree(this.child.pid);
		this.child = undefined;
		this.ready = false;
	}
}

/**
 * The decision backend for this environment: a configured loopback server, else a managed
 * `laya-serve` if it is installed, else none.
 */
export function decisionBackendFromEnv(env: NodeJS.ProcessEnv = process.env): DecisionBackend | undefined {
	if (env.MIDNIGHT_SERVER_LAYA !== undefined && !truthy(env.MIDNIGHT_SERVER_LAYA)) return undefined;
	const model = env.MIDNIGHT_SERVER_LAYA_MODEL?.trim() || undefined;
	const url = env.MIDNIGHT_SERVER_LAYA_URL?.trim();
	if (url) {
		if (!isLoopbackUrl(url)) return undefined;
		return new SystemOneClient({
			baseUrl: url,
			apiKey: env.MIDNIGHT_SERVER_LAYA_API_KEY?.trim() || undefined,
			model,
		});
	}
	if (!onPath("laya-serve")) return undefined;
	return new ManagedLaya({ model, offline: truthy(env.MIDNIGHT_SERVER_OFFLINE) });
}

// ---------------------------------------------------------------------------
// The review battery: after a run ends and deterministic checks pass (or none exist), ask
// independent questions about the change. Fast models most often fail by stopping early:
// they fix the literal request and miss what it implied, or claim success without evidence.
// ---------------------------------------------------------------------------

/** Bump when a question's wording or meaning changes: thresholds are calibrated per version. */
export const REVIEW_VERSION = "review-v1";

export const REVIEW_QUESTIONS: Record<string, DecisionQuestion> = {
	addresses_request: {
		type: "noul",
		instructions:
			"Does `change.diff` fully do what `request` asks, including requirements the request clearly implies but does not list?",
		criteria: {
			true: "Every stated and clearly implied requirement is handled by the diff.",
			false: "Some stated or clearly implied requirement is missing, or the diff solves a different problem.",
		},
	},
	unrelated_changes: {
		type: "noul",
		instructions: "Does `change.diff` change things that `request` does not need?",
		criteria: {
			true: "The diff contains edits unrelated to the request (refactors, reformatting, other features).",
			false: "Every edit in the diff serves the request.",
		},
	},
	unsupported_claims: {
		type: "noul",
		instructions:
			"Does `final_message` claim results that `change` does not show, such as tests passing when `change.checks` shows none ran or some failed?",
	},
	weakened_tests: {
		type: "noul",
		instructions:
			"Does `change.diff` weaken, skip or delete tests or assertions to make them pass instead of fixing the code?",
	},
};

/** Field order is significant: Laya serializes the state in order and truncates the tail. */
export interface ReviewState {
	request: string;
	final_message: string;
	change: { files: string[]; checks: string; diff: string };
}

/** Characters of state that fit Laya's 512-token checkpoint after the question header. */
export const REVIEW_STATE_CHARS = 1_800;

/**
 * Keep only what the review needs, most important first: Laya reads 512 or 1,024 tokens and
 * truncates the rest, so the request comes before the claims, the check results and the diff,
 * and the diff keeps its file headers and changed lines but drops unchanged context.
 */
export function compactReviewState(state: ReviewState, maxChars = REVIEW_STATE_CHARS): ReviewState {
	const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);
	const request = cut(state.request.trim(), 600);
	const finalMessage = cut(state.final_message.trim(), 300);
	const checks = cut(state.change.checks.trim(), 200);
	const changedLines = state.change.diff
		.split("\n")
		.filter((line) => /^(\+\+\+ |[+-](?![+-]{2}))/.test(line))
		.map((line) => (line.startsWith("+++ ") ? `# ${line.slice(4).replace(/^b\//, "").replace(/\t.*$/, "")}` : line));
	const room = Math.max(200, maxChars - request.length - finalMessage.length - checks.length - 150);
	return {
		request,
		final_message: finalMessage,
		change: { files: state.change.files.slice(0, 10), checks, diff: cut(changedLines.join("\n"), room) },
	};
}

export interface ReviewVerdict {
	/** Probabilities from the backend; undefined when no decision was available. */
	probabilities: Record<string, number>;
	/** What the policy decided: continue with feedback, or accept. */
	action: "revise" | "accept";
	reasons: string[];
}

/**
 * Policy over the review answers. Asymmetric thresholds: a revision costs one more turn of a
 * cheap model, a false "done" costs the user's trust, but a wrong nudge on correct work costs
 * both, so only confident negative judgments trigger a revision.
 */
export const REVIEW_THRESHOLDS = {
	addressesBelow: 0.3,
	unrelatedAbove: 0.85,
	unsupportedAbove: 0.85,
	weakenedAbove: 0.8,
};

export function reviewPolicy(answers: Record<string, DecisionAnswer>): ReviewVerdict {
	const probabilities: Record<string, number> = {};
	for (const [name, answer] of Object.entries(answers)) if (answer.type === "noul") probabilities[name] = answer.noul;
	const reasons: string[] = [];
	const p = (name: string) => probabilities[name];
	if (p("addresses_request") !== undefined && p("addresses_request") < REVIEW_THRESHOLDS.addressesBelow) {
		reasons.push(
			"The change may not do everything the request asks, including what it implies but does not list. Reread the request, list its requirements, and check each one against your diff.",
		);
	}
	if (p("weakened_tests") !== undefined && p("weakened_tests") > REVIEW_THRESHOLDS.weakenedAbove) {
		reasons.push(
			"The change appears to weaken or skip tests. Fix the code under test instead and restore the tests.",
		);
	}
	if (p("unrelated_changes") !== undefined && p("unrelated_changes") > REVIEW_THRESHOLDS.unrelatedAbove) {
		reasons.push(
			"The diff appears to include changes the request does not need. Revert them unless they are required.",
		);
	}
	if (p("unsupported_claims") !== undefined && p("unsupported_claims") > REVIEW_THRESHOLDS.unsupportedAbove) {
		reasons.push(
			"Your final message claims results the checks do not show. Verify them, or state plainly what was not verified.",
		);
	}
	return { probabilities, action: reasons.length > 0 ? "revise" : "accept", reasons };
}

export function formatReviewFeedback(verdict: ReviewVerdict, backend: string): string {
	const shown = Object.entries(verdict.probabilities)
		.map(([name, value]) => `${name} ${Math.round(value * 100)}%`)
		.join(", ");
	return [
		`An independent review of your change (${backend}, ${REVIEW_VERSION}: ${shown}) found:`,
		...verdict.reasons.map((reason) => `- ${reason}`),
		"Address these, or explain briefly why the change is already correct. This review runs once per request.",
	].join("\n");
}

/** Stable digest of a decision's inputs, for receipts. */
export function stateDigest(state: unknown, version: string): string {
	return createHash("sha256")
		.update(`${version}\0${JSON.stringify(state)}`)
		.digest("hex")
		.slice(0, 16);
}

/**
 * Intake questions for the first prompt. Their answers only add a short note to the context
 * pack; they never block the run.
 */
export const INTAKE_VERSION = "intake-v1";

export const INTAKE_QUESTIONS: Record<string, DecisionQuestion> = {
	complexity: {
		type: "score",
		instructions:
			"How much multi-step reasoning does `request` need, given `candidates` (the files most likely involved)?",
		criteria: [
			"Direct: one obvious change in one place.",
			"Moderate: a few related changes or one non-obvious fix.",
			"Deep: design decisions, many files, or an unclear root cause.",
		],
	},
	ambiguous: {
		type: "noul",
		instructions:
			"Could `request` reasonably be read in two ways that lead to different code, so that a careful engineer would ask before starting?",
	},
};

export function intakeNote(answers: Record<string, DecisionAnswer>): { note?: string; deep: boolean } {
	const complexity = answers.complexity;
	const ambiguous = answers.ambiguous;
	const deep = complexity?.type === "score" && complexity.score >= 1.5 && complexity.confidence >= 0.5;
	const notes: string[] = [];
	if (ambiguous?.type === "noul" && ambiguous.noul > 0.8) {
		notes.push(
			"An intake check found this request may be read in more than one way. If the reading changes what you would build, ask the user before editing; otherwise state the reading you chose.",
		);
	}
	if (deep) {
		notes.push(
			"An intake check rated this request as needing deep reasoning. Find the root cause before editing, and list the requirements you will verify.",
		);
	}
	return { note: notes.length > 0 ? notes.join("\n") : undefined, deep };
}
