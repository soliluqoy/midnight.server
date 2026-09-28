import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { type IdleOptions, IdleScheduler } from "./idle.ts";
import type { GoalRequest, Lattice } from "./kernel.ts";

/**
 * The resident core loop and local IPC (spec sections 5.2, 17.2 and 44.7). One process, one
 * bounded inbox. Interactive events run first; a background improvement runs in its isolated
 * worker and is cancelled when interactive work arrives, so the user never waits on search.
 * A full inbox answers "busy" instead of silently dropping a command.
 */
export const INBOX_LIMIT = 256;

type Job = {
	run(signal: AbortSignal): Promise<unknown>;
	resolve(value: unknown): void;
	reject(error: unknown): void;
};

/**
 * Two lanes. Interactive jobs run one at a time, in order. A background job starts only when no
 * interactive work is running or waiting, and is cancelled as soon as interactive work arrives.
 */
export class KernelLoop {
	private readonly interactive: Job[] = [];
	private readonly background: Job[] = [];
	private interactiveBusy = false;
	private backgroundRun: AbortController | undefined;
	/** `performance.now()` of the last interactive submission; idle-time work waits after it. */
	lastInteractiveAt = Number.NEGATIVE_INFINITY;

	get depth(): number {
		return this.interactive.length + this.background.length;
	}

	/** Nothing running and nothing queued. */
	get idle(): boolean {
		return !this.interactiveBusy && !this.backgroundRun && this.depth === 0;
	}

	/** Enqueue work; rejects immediately with a busy error when the inbox is full. */
	submit<T>(interactive: boolean, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.depth >= INBOX_LIMIT) return Promise.reject(new Error(`busy: ${INBOX_LIMIT} events queued`));
		return new Promise<T>((resolve, reject) => {
			const job: Job = { run, resolve: resolve as (value: unknown) => void, reject };
			if (interactive) {
				this.lastInteractiveAt = performance.now();
				this.interactive.push(job);
				this.backgroundRun?.abort();
			} else this.background.push(job);
			this.pump();
		});
	}

	private pump(): void {
		if (!this.interactiveBusy && this.interactive.length > 0) {
			const job = this.interactive.shift()!;
			this.interactiveBusy = true;
			job.run(new AbortController().signal)
				.then(job.resolve, job.reject)
				.finally(() => {
					this.interactiveBusy = false;
					this.pump();
				});
		}
		if (!this.interactiveBusy && this.interactive.length === 0 && !this.backgroundRun && this.background.length > 0) {
			const job = this.background.shift()!;
			const controller = new AbortController();
			this.backgroundRun = controller;
			job.run(controller.signal)
				.then(job.resolve, job.reject)
				.finally(() => {
					this.backgroundRun = undefined;
					this.pump();
				});
		}
	}
}

export function defaultPipePath(dataDir: string): string {
	const id = createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
	return process.platform === "win32" ? `\\\\.\\pipe\\lattice-${id}` : join(dataDir, "lattice.sock");
}

async function body(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		// Frames above 1 MiB are rejected (section 44.6); large inputs go through the broker.
		if (size > 1_048_576) throw new Error("request exceeds 1 MiB");
		chunks.push(chunk as Buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	return text ? (JSON.parse(text) as unknown) : {};
}

function send(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(`${JSON.stringify(value)}\n`);
}

/**
 * Serve the local API on a named pipe (Windows) or Unix socket, never a network port.
 * Every request needs the per-installation token; requests carrying an Origin header
 * (browsers) are refused.
 */
export function serve(
	lattice: Lattice,
	options: { path?: string; idle?: IdleOptions } = {},
): { server: Server; path: string; token: string; loop: KernelLoop; scheduler?: IdleScheduler } {
	let token = lattice.store.getMeta("ipc_token");
	if (!token) {
		token = randomBytes(24).toString("hex");
		lattice.store.setMeta("ipc_token", token);
	}
	const expected = Buffer.from(`Bearer ${token}`);
	const loop = new KernelLoop();
	const path = options.path ?? defaultPipePath(lattice.store.dataDir);
	const server = createServer((request, response) => {
		void (async () => {
			try {
				if (request.headers.origin) return send(response, 403, { error: "cross-origin requests are refused" });
				const auth = Buffer.from(request.headers.authorization ?? "");
				if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
					return send(response, 401, { error: "missing or wrong token" });
				}
				const url = new URL(request.url ?? "/", "http://lattice");
				const parts = url.pathname.split("/").filter(Boolean);
				const method = request.method ?? "GET";
				if (parts[0] !== "v1") return send(response, 404, { error: "unknown route" });
				const route = `${method} /${parts.slice(1).join("/")}`;
				if (route === "POST /goals" || route === "POST /events") {
					const payload = (await body(request)) as GoalRequest;
					return send(response, 200, await loop.submit(true, () => lattice.submitGoal(payload)));
				}
				if (method === "GET" && parts[1] === "goals" && parts[2])
					return send(response, 200, lattice.explainEpisode(parts[2]));
				if (route === "GET /skills") return send(response, 200, (lattice.status() as { skills: unknown }).skills);
				if (method === "GET" && parts[1] === "skills" && parts[3] === "versions") {
					return send(response, 200, lattice.explainSkill(decodeURIComponent(parts[2])));
				}
				if (method === "POST" && parts[1] === "skills" && parts[3] === "run") {
					const payload = (await body(request)) as { input: unknown };
					const skill = decodeURIComponent(parts[2]);
					return send(response, 200, await loop.submit(true, async () => lattice.runSkill(skill, payload.input)));
				}
				if (route === "POST /improvements") {
					const payload = (await body(request)) as { skill: string };
					const report = await loop.submit(false, (signal) =>
						lattice.improve(payload.skill, { explore: true, signal }),
					);
					return send(response, 200, report);
				}
				if (method === "GET" && parts[1] === "improvements" && parts[2]) {
					const campaign = lattice.store.db
						.prepare(
							"SELECT campaign_id, skill_id, kind, status, record_json FROM campaigns WHERE campaign_id = ?",
						)
						.get(parts[2]);
					return campaign ? send(response, 200, campaign) : send(response, 404, { error: "unknown campaign" });
				}
				if (route === "GET /plans") return send(response, 200, lattice.plans());
				if (method === "POST" && parts[1] === "plans" && (parts[3] === "apply" || parts[3] === "undo")) {
					const planId = decodeURIComponent(parts[2]);
					const action = parts[3];
					return send(
						response,
						200,
						await loop.submit(true, async () =>
							action === "apply" ? lattice.applyPlan(planId) : lattice.undoPlan(planId),
						),
					);
				}
				if (route === "POST /rollback") {
					const payload = (await body(request)) as { skill: string; to_version?: number };
					return send(
						response,
						200,
						await loop.submit(true, async () => lattice.rollback(payload.skill, payload.to_version)),
					);
				}
				if (route === "GET /audit")
					return send(response, 200, lattice.store.auditLog(url.searchParams.get("subject") ?? undefined));
				if (route === "GET /metrics")
					return send(response, 200, { ...(lattice.status() as object), inbox: loop.depth });
				return send(response, 404, { error: "unknown route" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return send(response, message.startsWith("busy") ? 503 : 400, { error: message });
			}
		})();
	});
	server.listen(path);
	const scheduler = options.idle ? new IdleScheduler(lattice, loop, options.idle) : undefined;
	scheduler?.start();
	server.on("close", () => scheduler?.stop());
	return { server, path, token, loop, scheduler };
}
