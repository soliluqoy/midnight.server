import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnProcess } from "../utils/child-process.ts";
import { killProcessTree } from "../utils/shell.ts";

/**
 * A minimal Language Server Protocol client, and discovery of servers the machine already
 * has. Language servers answer "where is X defined", "who calls X" and "what is broken in
 * this file" exactly, in one request, where a model would otherwise grep and read.
 *
 * Only what the harness uses is implemented: initialize, document sync, definition,
 * references, document and workspace symbols, and published diagnostics. Nothing is
 * downloaded: a server is used only if it is in the project's `node_modules/.bin` or on PATH.
 * Starting a project-local server runs project code, so callers require project trust.
 */

export interface LspPosition {
	line: number;
	character: number;
}

export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

export interface LspLocation {
	uri: string;
	range: LspRange;
}

export interface LspDiagnostic {
	range: LspRange;
	severity?: number;
	message: string;
	source?: string;
	code?: string | number;
}

export interface LspSymbol {
	name: string;
	kind: number;
	range?: LspRange;
	selectionRange?: LspRange;
	location?: LspLocation;
	children?: LspSymbol[];
	containerName?: string;
}

export interface ServerSpec {
	id: string;
	command: string;
	args: string[];
	languageId: (path: string) => string;
	extensions: string[];
}

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function tsLanguageId(path: string): string {
	const extension = extname(path).toLowerCase();
	if (extension === ".tsx") return "typescriptreact";
	if (extension === ".jsx") return "javascriptreact";
	if ([".js", ".mjs", ".cjs"].includes(extension)) return "javascript";
	return "typescript";
}

const SERVERS: Array<Omit<ServerSpec, "command"> & { binaries: string[] }> = [
	{
		id: "typescript",
		binaries: ["typescript-language-server"],
		args: ["--stdio"],
		languageId: tsLanguageId,
		extensions: TS_EXTENSIONS,
	},
	{
		id: "python",
		binaries: ["pyright-langserver", "basedpyright-langserver"],
		args: ["--stdio"],
		languageId: () => "python",
		extensions: [".py"],
	},
	{ id: "go", binaries: ["gopls"], args: [], languageId: () => "go", extensions: [".go"] },
	{ id: "rust", binaries: ["rust-analyzer"], args: [], languageId: () => "rust", extensions: [".rs"] },
];

function findExecutable(name: string, cwd: string): string | undefined {
	const suffixes = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
	const dirs = [join(cwd, "node_modules", ".bin"), ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)];
	for (const dir of dirs) {
		for (const suffix of suffixes) {
			const candidate = join(dir, `${name}${suffix}`);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

/** The server for a file, if one is installed. */
export function discoverServer(path: string, cwd: string): ServerSpec | undefined {
	const extension = extname(path).toLowerCase();
	for (const spec of SERVERS) {
		if (!spec.extensions.includes(extension)) continue;
		for (const binary of spec.binaries) {
			const command = findExecutable(binary, cwd);
			if (command) return { ...spec, command };
		}
	}
	return undefined;
}

export function fileUri(path: string): string {
	return pathToFileURL(resolve(path)).href;
}

export function uriPath(uri: string): string {
	return fileURLToPath(uri);
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class LspClient {
	readonly spec: ServerSpec;
	private readonly root: string;
	private child: ChildProcess | undefined;
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly versions = new Map<string, number>();
	private readonly diagnostics = new Map<string, { version?: number; items: LspDiagnostic[]; at: number }>();
	private readonly diagnosticWaiters = new Set<() => void>();
	private initialized: Promise<void> | undefined;
	dead = false;

	constructor(spec: ServerSpec, root: string) {
		this.spec = spec;
		this.root = root;
	}

	start(timeoutMs = 30_000): Promise<void> {
		this.initialized ??= this.initialize(timeoutMs);
		return this.initialized;
	}

	private async initialize(timeoutMs: number): Promise<void> {
		const child = spawnProcess(this.spec.command, this.spec.args, {
			cwd: this.root,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child = child;
		child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
		child.stderr?.on("data", () => {});
		child.on("exit", () => this.markDead(new Error(`${this.spec.id} language server exited`)));
		child.on("error", (error) => this.markDead(error));
		await this.request(
			"initialize",
			{
				processId: process.pid,
				rootUri: fileUri(this.root),
				workspaceFolders: [{ uri: fileUri(this.root), name: "workspace" }],
				capabilities: {
					textDocument: {
						synchronization: { didSave: true },
						publishDiagnostics: { versionSupport: true },
						definition: { linkSupport: false },
						references: {},
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
					},
					workspace: { symbol: {}, workspaceFolders: true, configuration: true },
				},
			},
			timeoutMs,
		);
		this.notify("initialized", {});
		this.notify("workspace/didChangeConfiguration", { settings: {} });
	}

	private markDead(error: Error): void {
		if (this.dead) return;
		this.dead = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		for (const wake of this.diagnosticWaiters) wake();
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const header = this.buffer.subarray(0, headerEnd).toString("ascii");
			const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
			if (!Number.isFinite(length)) {
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}
			if (this.buffer.length < headerEnd + 4 + length) return;
			const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
			this.buffer = this.buffer.subarray(headerEnd + 4 + length);
			try {
				this.onMessage(JSON.parse(body) as Record<string, unknown>);
			} catch {
				// Ignore malformed messages.
			}
		}
	}

	private onMessage(message: Record<string, unknown>): void {
		if (typeof message.id === "number" && ("result" in message || "error" in message) && !("method" in message)) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) {
				const error = message.error as { message?: string };
				pending.reject(new Error(error.message ?? "language server error"));
			} else pending.resolve(message.result);
			return;
		}
		const method = message.method;
		if (method === "textDocument/publishDiagnostics") {
			const params = message.params as { uri: string; version?: number; diagnostics: LspDiagnostic[] };
			this.diagnostics.set(params.uri, { version: params.version, items: params.diagnostics, at: Date.now() });
			for (const wake of this.diagnosticWaiters) wake();
			return;
		}
		if (typeof message.id === "number" || typeof message.id === "string") {
			// Server-to-client requests: answer so the server does not wait on us.
			let result: unknown = null;
			if (method === "workspace/configuration") {
				const items = ((message.params as { items?: unknown[] })?.items ?? []).length;
				// Empty settings, not null: some servers (pyright) stop analysing on null.
				result = Array.from({ length: items }, () => ({}));
			}
			this.send({ jsonrpc: "2.0", id: message.id, result });
		}
	}

	private send(message: unknown): void {
		const body = Buffer.from(JSON.stringify(message), "utf8");
		this.child?.stdin?.write(`Content-Length: ${body.length}\r\n\r\n`);
		this.child?.stdin?.write(body);
	}

	request<T = unknown>(method: string, params: unknown, timeoutMs = 10_000): Promise<T> {
		if (this.dead) return Promise.reject(new Error(`${this.spec.id} language server is not running`));
		const id = this.nextId++;
		return new Promise<T>((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out after ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolvePromise as (value: unknown) => void, reject, timer });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		if (!this.dead) this.send({ jsonrpc: "2.0", method, params });
	}

	/** Open or update a document with its current content. Returns its new version. */
	sync(path: string, content?: string): number {
		const uri = fileUri(path);
		const text = content ?? readFileSync(path, "utf8");
		const version = (this.versions.get(uri) ?? 0) + 1;
		if (version === 1) {
			this.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: this.spec.languageId(path), version, text },
			});
		} else {
			this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
		}
		this.versions.set(uri, version);
		return version;
	}

	/**
	 * Diagnostics for a document after `since` (ms timestamp). Waits until the server
	 * publishes, then a short quiet period for follow-up publishes, up to `timeoutMs`.
	 */
	async diagnosticsFor(path: string, since: number, timeoutMs = 8_000): Promise<LspDiagnostic[] | undefined> {
		const uri = fileUri(path);
		const deadline = Date.now() + timeoutMs;
		const fresh = () => {
			const entry = this.diagnostics.get(uri);
			return entry && entry.at >= since ? entry : undefined;
		};
		while (!this.dead && Date.now() < deadline) {
			const entry = fresh();
			if (entry) {
				// Servers often publish syntax errors first and semantic errors shortly after.
				await new Promise<void>((resolveWait) => {
					const wake = () => {
						clearTimeout(timer);
						this.diagnosticWaiters.delete(wake);
						resolveWait();
					};
					const timer = setTimeout(wake, Math.min(600, Math.max(0, deadline - Date.now())));
					this.diagnosticWaiters.add(wake);
				});
				const latest = fresh();
				if (latest === entry || !latest) return entry.items;
				continue;
			}
			await new Promise<void>((resolveWait) => {
				const wake = () => {
					clearTimeout(timer);
					this.diagnosticWaiters.delete(wake);
					resolveWait();
				};
				const timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
				this.diagnosticWaiters.add(wake);
			});
		}
		return fresh()?.items;
	}

	async definition(path: string, position: LspPosition): Promise<LspLocation[]> {
		const result = await this.request<unknown>("textDocument/definition", {
			textDocument: { uri: fileUri(path) },
			position,
		});
		return normalizeLocations(result);
	}

	async references(path: string, position: LspPosition): Promise<LspLocation[]> {
		const result = await this.request<unknown>(
			"textDocument/references",
			{ textDocument: { uri: fileUri(path) }, position, context: { includeDeclaration: false } },
			15_000,
		);
		return normalizeLocations(result);
	}

	async documentSymbols(path: string): Promise<LspSymbol[]> {
		const result = await this.request<LspSymbol[] | null>("textDocument/documentSymbol", {
			textDocument: { uri: fileUri(path) },
		});
		return result ?? [];
	}

	async workspaceSymbols(query: string): Promise<LspSymbol[]> {
		const result = await this.request<LspSymbol[] | null>("workspace/symbol", { query }, 15_000);
		return result ?? [];
	}

	async stop(): Promise<void> {
		if (!this.child || this.dead) return;
		try {
			await this.request("shutdown", null, 2_000);
			this.notify("exit", null);
		} catch {
			// Kill below.
		}
		const pid = this.child.pid;
		setTimeout(() => {
			if (!this.dead && pid) killProcessTree(pid);
		}, 1_000).unref();
	}

	kill(): void {
		if (this.child?.pid && !this.dead) killProcessTree(this.child.pid);
	}
}

function normalizeLocations(result: unknown): LspLocation[] {
	if (!result) return [];
	const items = Array.isArray(result) ? result : [result];
	const locations: LspLocation[] = [];
	for (const item of items) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		if (typeof record.uri === "string" && record.range) locations.push(record as unknown as LspLocation);
		else if (typeof record.targetUri === "string" && record.targetSelectionRange) {
			locations.push({ uri: record.targetUri, range: record.targetSelectionRange as LspRange });
		}
	}
	return locations;
}

/**
 * One client per server kind per session, started lazily. A server that fails to start is
 * not retried in the same session.
 */
export class LspManager {
	private readonly root: string;
	private readonly clients = new Map<string, LspClient>();
	private readonly failed = new Set<string>();

	constructor(root: string) {
		this.root = root;
	}

	async clientFor(path: string): Promise<LspClient | undefined> {
		const spec = discoverServer(path, this.root);
		if (!spec || this.failed.has(spec.id)) return undefined;
		let client = this.clients.get(spec.id);
		if (client?.dead) {
			this.clients.delete(spec.id);
			client = undefined;
		}
		if (!client) {
			client = new LspClient(spec, this.root);
			this.clients.set(spec.id, client);
		}
		try {
			await client.start();
			return client;
		} catch {
			this.failed.add(spec.id);
			this.clients.delete(spec.id);
			client.kill();
			return undefined;
		}
	}

	get running(): string[] {
		return [...this.clients.values()].filter((client) => !client.dead).map((client) => client.spec.id);
	}

	async dispose(): Promise<void> {
		await Promise.all([...this.clients.values()].map((client) => client.stop()));
		this.clients.clear();
	}
}
