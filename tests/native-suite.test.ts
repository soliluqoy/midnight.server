import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { browserArguments, browserEndpoint, registerBrowser } from "../src/browser.ts";
import { externalContextPresent, ownedAPI, registerAvailableAliases } from "../src/core/ownership.ts";
import { registerSuite, suiteSettings } from "../src/core/suite.ts";

type Handler = (...args: unknown[]) => unknown;
type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
function harness() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Command>();
	const notifications: string[] = [];
	const registrations: unknown[] = [];
	let inspected = 0;
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		registerTool: () => {},
		getCommands: () => {
			inspected++;
			return [...commands.keys()].map((name) => ({ name }));
		},
		getAllTools: () => [],
		appendEntry: () => {},
		registerMcpServer: (...args: unknown[]) => registrations.push(args),
		unregisterMcpServer: (name: string) => registrations.push(["unregister", name]),
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => "test" },
		ui: { notify: (message: string) => notifications.push(message), confirm: async () => true },
	} as unknown as ExtensionCommandContext;
	const emit = async (event: string) => {
		for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	};
	return { pi, ctx, handlers, commands, notifications, registrations, emit, inspected: () => inspected };
}

test("defaults are versioned, branch-local and reject malformed settings", () => {
	assert.deepEqual(suiteSettings([], {}), { version: 1, context: true, checkpoints: true });
	assert.equal(suiteSettings([], { MIDNIGHT_CONTEXT: "off" }).context, false);
	const entry = {
		type: "custom",
		customType: "midnight-suite-settings",
		data: { version: 1, context: false, checkpoints: true },
	};
	assert.equal(suiteSettings([entry], {}).context, false);
	assert.equal(suiteSettings([{ ...entry, data: { version: 2, context: false } }], {}).context, true);
});

test("ownership recognizes external tools and commands, not canonical native names", () => {
	assert.equal(externalContextPresent(["clm"], []), true);
	assert.equal(externalContextPresent([], ["live_context_recall"]), true);
	assert.equal(externalContextPresent(["midnight-context"], ["midnight_context_recall"]), false);
});

test("guarded events preserve results and cleanup runs after ownership is relinquished", async () => {
	const h = harness();
	let active = true;
	let cleanups = 0;
	const facade = ownedAPI(h.pi, () => active, new Map());
	facade.on("context", async () => ({ messages: [] }));
	facade.on("session_shutdown", () => {
		cleanups++;
	});
	const context = h.handlers.get("context")?.[0];
	assert.ok(context);
	assert.deepEqual(await context({}, h.ctx), { messages: [] });
	active = false;
	assert.equal(await context({}, h.ctx), undefined);
	await h.emit("session_shutdown");
	assert.equal(cleanups, 1);
});

test("aliases never overwrite existing commands", () => {
	const h = harness();
	const noop = { description: "test", handler: async () => {} };
	h.commands.set("clm", noop);
	const aliases = registerAvailableAliases(h.pi, new Map([["native", noop]]), { clm: "native", rewind: "native" });
	assert.deepEqual([...aliases], ["rewind"]);
	assert.equal(h.commands.get("clm"), noop);
});

test("suite factory does not inspect the unbound host; duplicate engines pause native work", async () => {
	const h = harness();
	h.commands.set("clm", { description: "external", handler: async () => {} });
	h.commands.set("rewind", { description: "external", handler: async () => {} });
	const suite = registerSuite(h.pi, () => {});
	assert.equal(h.inspected(), 0);
	await h.emit("session_start");
	assert.match(suite.status(), /Context: external/);
	assert.match(suite.status(), /Checkpoints: external/);
	await suite.command("context status", h.ctx);
	assert.match(h.notifications.at(-1) ?? "", /inactive/);
});

test("browser endpoint validation forbids remote hosts and credential-bearing URLs", () => {
	assert.equal(browserEndpoint("http://127.0.0.1:9222"), "http://127.0.0.1:9222/");
	for (const value of [
		"https://127.0.0.1:9222",
		"http://example.org:9222",
		"http://user:pass@localhost:9222",
		"http://localhost:9222/path",
		"http://localhost:9222/?secret=x",
	])
		assert.throws(() => browserEndpoint(value));
	assert.deepEqual(browserArguments("server.js", "http://localhost:9222"), [
		"server.js",
		"--browser-url=http://localhost:9222/",
		"--no-usage-statistics",
		"--no-performance-crux",
		"--redact-network-headers",
	]);
});

test("browser is off by default, needs confirmation, and unregisters on shutdown", async () => {
	const h = harness();
	const browser = registerBrowser(h.pi);
	assert.equal(h.registrations.length, 0);
	h.ctx.ui.confirm = async () => false;
	await browser.command("connect http://127.0.0.1:9222", h.ctx);
	assert.equal(h.registrations.length, 0);
	h.ctx.ui.confirm = async () => true;
	await browser.command("connect http://127.0.0.1:9222", h.ctx);
	assert.equal(h.registrations.length, 1);
	await h.emit("session_shutdown");
	assert.deepEqual(h.registrations.at(-1), ["unregister", "chrome_devtools"]);
});

test("shutdown discards a pending browser confirmation and noninteractive connect cannot register", async () => {
	const h = harness();
	const browser = registerBrowser(h.pi);
	const headless = { ...h.ctx, hasUI: false } as ExtensionCommandContext;
	await browser.command("connect http://127.0.0.1:9222", headless);
	assert.equal(h.registrations.length, 0);
	let answer: (value: boolean) => void = () => {};
	let prompted: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		prompted = resolve;
	});
	h.ctx.ui.confirm = () => {
		prompted();
		return new Promise<boolean>((resolve) => {
			answer = resolve;
		});
	};
	const pending = browser.command("connect http://127.0.0.1:9222", h.ctx);
	await ready;
	await h.emit("session_shutdown");
	answer(true);
	await pending;
	assert.equal(h.registrations.length, 0);
});
