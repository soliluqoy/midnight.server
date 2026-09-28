import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import harnessExtension, { CHECK_MESSAGE_TYPE } from "../../src/harness/extension.ts";
import { createHarness, type Harness } from "./harness.ts";

function contextText(context: Context): string {
	return context.messages
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => ("text" in part ? part.text : "")).join("\n"),
		)
		.join("\n---\n");
}

function customMessages(harness: Harness, customType: string): string[] {
	return harness.session.messages.flatMap((message) =>
		message.role === "custom" && message.customType === customType
			? [typeof message.content === "string" ? message.content : JSON.stringify(message.content)]
			: [],
	);
}

function initGit(dir: string): void {
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	git("init", "-q");
	git("add", "-A");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start");
}

/** A project whose check passes when value.js exports 1 and fails otherwise. */
function writeProject(dir: string, options: { escalationModel?: string } = {}): void {
	writeFileSync(join(dir, "value.js"), "module.exports = 1;\n");
	writeFileSync(
		join(dir, "check.js"),
		"const v = require('./value.js'); if (v !== 1) { console.error('expected 1, got ' + v); process.exit(1); }\n",
	);
	mkdirSync(join(dir, ".midnight.server"), { recursive: true });
	writeFileSync(
		join(dir, ".midnight.server", "harness.json"),
		JSON.stringify({
			checks: [{ name: "value", command: ["node", "check.js"], when: ["*.js"] }],
			protect: ["check.js"],
			...(options.escalationModel
				? { escalation: { model: options.escalationModel }, features: { escalation: true } }
				: {}),
		}),
	);
}

/**
 * A project with a lint check that already fails: legacy.js has a BAD marker. The check reports
 * each marker as `file:line: error BAD marker`.
 */
function writeLintProject(dir: string): void {
	writeFileSync(join(dir, "legacy.js"), "// BAD\nmodule.exports = 0;\n");
	writeFileSync(join(dir, "value.js"), "module.exports = 1;\n");
	writeFileSync(
		join(dir, "lint.js"),
		[
			"const fs = require('fs');",
			"let failed = false;",
			"for (const file of fs.readdirSync('.').filter((name) => name.endsWith('.js') && name !== 'lint.js').sort()) {",
			"  fs.readFileSync(file, 'utf8').split('\\n').forEach((line, index) => {",
			"    if (line.includes('BAD')) { console.log(file + ':' + (index + 1) + ': error BAD marker'); failed = true; }",
			"  });",
			"}",
			"process.exit(failed ? 1 : 0);",
		].join("\n"),
	);
	mkdirSync(join(dir, ".midnight.server"), { recursive: true });
	writeFileSync(
		join(dir, ".midnight.server", "harness.json"),
		JSON.stringify({
			checks: [{ name: "lint", command: ["node", "lint.js"], when: ["*.js"] }],
			protect: ["lint.js"],
		}),
	);
}

describe("harness v2 in a session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(models?: Array<{ id: string; contextWindow?: number }>): Promise<Harness> {
		const harness = await createHarness({
			models,
			extensionFactories: [{ name: "harness", factory: harnessExtension }],
		});
		harnesses.push(harness);
		harness.settingsManager.setProjectTrusted(true);
		return harness;
	}

	it("sends a context pack with the ranked file's contents in the first request when switched on", async () => {
		const harness = await setup();
		writeFileSync(join(harness.tempDir, "port.js"), "function parsePort(value) {\n  return Number(value);\n}\n");
		writeFileSync(join(harness.tempDir, "other.js"), "function unrelated() {}\n");
		mkdirSync(join(harness.tempDir, ".midnight.server"), { recursive: true });
		writeFileSync(
			join(harness.tempDir, ".midnight.server", "harness.json"),
			JSON.stringify({ features: { contextPack: true } }),
		);
		let firstRequest = "";
		harness.setResponses([
			(context) => {
				firstRequest = contextText(context);
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("parsePort in port.js must reject NaN");
		expect(firstRequest).toContain("<workspace_context>");
		expect(firstRequest).toContain('<file path="port.js">');
		expect(firstRequest).toContain("return Number(value);");
	});

	it("puts the environment in the system prompt without the detected full suite it leaves to the model", async () => {
		const harness = await setup();
		writeFileSync(
			join(harness.tempDir, "package.json"),
			JSON.stringify({ name: "p", scripts: { test: "node test.js" } }),
		);
		let firstRequest = "";
		harness.setResponses([
			(context) => {
				firstRequest = JSON.stringify(context);
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("hello");
		expect(firstRequest).toContain("<environment>");
		expect(firstRequest).toContain("tests: `npm test`");
		expect(firstRequest).not.toContain("When you finish, the harness runs");
		expect(firstRequest).not.toContain("<workspace_context>");
	});

	it("rejects an edit that breaks the file's syntax and keeps the file unchanged", async () => {
		const harness = await setup();
		const file = join(harness.tempDir, "value.js");
		writeFileSync(file, "function a() {\n  return 1;\n}\n");
		let toolResult = "";
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "value.js",
						edits: [{ oldText: "  return 1;\n}", newText: "  return 2;" }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				toolResult = contextText(context);
				return fauxAssistantMessage("sorry");
			},
		]);
		await harness.session.prompt("change the return value");
		expect(toolResult).toContain("Edit rejected by the harness");
		expect(readFileSync(file, "utf8")).toBe("function a() {\n  return 1;\n}\n");
	});

	it("repairs an edit whose oldText differs only in indentation", async () => {
		const harness = await setup();
		const file = join(harness.tempDir, "value.js");
		writeFileSync(file, "function a() {\n\treturn 1;\n}\n");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "value.js",
						edits: [{ oldText: "    return 1;", newText: "    return 2;" }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("return 2");
		expect(readFileSync(file, "utf8")).toBe("function a() {\n\treturn 2;\n}\n");
	});

	it("checks once at settle, not while the model works", async () => {
		const harness = await setup();
		writeProject(harness.tempDir);
		writeFileSync(
			join(harness.tempDir, "count.js"),
			"require('fs').appendFileSync('runs.log', 'x'); require('./check.js');\n",
		);
		writeFileSync(
			join(harness.tempDir, ".midnight.server", "harness.json"),
			JSON.stringify({ checks: [{ name: "value", command: ["node", "count.js"], when: ["value.js"] }] }),
		);
		const requests: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "value.js",
						edits: [{ oldText: "module.exports = 1;", newText: "module.exports = 1; // ok" }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				requests.push(contextText(context));
				return fauxAssistantMessage([fauxToolCall("read", { path: "value.js" })], { stopReason: "toolUse" });
			},
			(context) => {
				requests.push(contextText(context));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("add a comment to value.js");
		expect(requests.join("\n")).not.toContain("Harness checks");
		expect(readFileSync(join(harness.tempDir, "runs.log"), "utf8")).toBe("x");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not check between turns that keep editing", async () => {
		const harness = await setup();
		writeProject(harness.tempDir);
		const requests: string[] = [];
		const edit = (from: string, to: string) =>
			fauxAssistantMessage([fauxToolCall("edit", { path: "value.js", edits: [{ oldText: from, newText: to }] })], {
				stopReason: "toolUse",
			});
		harness.setResponses([
			// Broken in between: the check would fail after this turn.
			edit("module.exports = 1;", "module.exports = 2;"),
			(context) => {
				requests.push(contextText(context));
				return edit("module.exports = 2;", "module.exports = 1; // back");
			},
			(context) => {
				requests.push(contextText(context));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("rework value.js");
		expect(requests.join("\n")).not.toContain("Harness checks");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each([
		["skips the check the model already ran after its last change", false, 1],
		["reruns the check when the model edited after running it", true, 2],
	])("%s", async (_label, editAfter, runs) => {
		const harness = await setup();
		writeProject(harness.tempDir);
		writeFileSync(
			join(harness.tempDir, "count.js"),
			"require('fs').appendFileSync('runs.log', 'x'); require('./check.js');\n",
		);
		writeFileSync(
			join(harness.tempDir, ".midnight.server", "harness.json"),
			JSON.stringify({ checks: [{ name: "value", command: ["node", "count.js"], when: ["value.js"] }] }),
		);
		const shell = process.platform === "win32" ? "powershell" : "bash";
		const edit = (from: string, to: string) =>
			fauxAssistantMessage([fauxToolCall("edit", { path: "value.js", edits: [{ oldText: from, newText: to }] })], {
				stopReason: "toolUse",
			});
		harness.setResponses([
			edit("module.exports = 1;", "module.exports = 1; // ok"),
			fauxAssistantMessage([fauxToolCall(shell, { command: "node count.js" })], { stopReason: "toolUse" }),
			...(editAfter ? [edit("module.exports = 1; // ok", "module.exports = 1; // ok again")] : []),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("add a comment to value.js");
		expect(readFileSync(join(harness.tempDir, "runs.log"), "utf8")).toHaveLength(runs);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("sends advice from the escalation model with the repair feedback when switched on", async () => {
		const harness = await setup([{ id: "fast" }, { id: "strong" }]);
		writeProject(harness.tempDir, { escalationModel: "faux/strong" });
		let advisorPrompt = "";
		let adviceSeen = "";
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "value.js",
						edits: [{ oldText: "module.exports = 1;", newText: "module.exports = 2;" }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
			// The settle check fails: the harness consults the strong model before the repair round.
			(context) => {
				advisorPrompt = contextText(context);
				return fauxAssistantMessage("Root cause: value.js must export 1. Revert the change.");
			},
			(context) => {
				adviceSeen = contextText(context);
				return fauxAssistantMessage("reverting");
			},
		]);
		await harness.session.prompt("set value to 2");
		expect(advisorPrompt).toContain("<request>\nset value to 2");
		expect(advisorPrompt).toContain("expected 1, got 2");
		expect(adviceSeen).toContain("Harness checks failed after your changes (repair round 1 of 1)");
		expect(adviceSeen).toContain("Advice from faux/strong");
		expect(adviceSeen).toContain("Root cause: value.js must export 1");
	});

	it("does not consult another model unless escalation is switched on", async () => {
		const harness = await setup([{ id: "fast" }, { id: "strong" }]);
		writeProject(harness.tempDir);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "value.js",
						edits: [{ oldText: "module.exports = 1;", newText: "module.exports = 2;" }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("still done"),
		]);
		await harness.session.prompt("set value to 2");
		const messages = customMessages(harness, CHECK_MESSAGE_TYPE);
		expect(messages).toHaveLength(2);
		expect(messages[1]).toContain("stopping here");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not start a repair round for lint errors the project already had", async () => {
		const harness = await setup();
		writeLintProject(harness.tempDir);
		initGit(harness.tempDir);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "value.js",
						edits: [{ oldText: "module.exports = 1;", newText: "module.exports = 2;" }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("export 2 from value.js");
		// Without the baseline the settle check fails on legacy.js and sends the model back.
		expect(customMessages(harness, CHECK_MESSAGE_TYPE)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("feeds back only the lint errors the change added", async () => {
		const harness = await setup();
		writeLintProject(harness.tempDir);
		initGit(harness.tempDir);
		let feedback = "";
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "value.js",
						edits: [{ oldText: "module.exports = 1;", newText: "// BAD\nmodule.exports = 1;" }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
			(context) => {
				feedback = contextText(context);
				return fauxAssistantMessage(
					[fauxToolCall("edit", { path: "value.js", edits: [{ oldText: "// BAD\n", newText: "" }] })],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("fixed"),
		]);
		await harness.session.prompt("touch value.js");
		expect(feedback).toContain("repair round 1");
		expect(feedback).toContain("value.js:1: error BAD marker");
		expect(feedback).not.toContain("legacy.js:1: error BAD marker");
		expect(feedback).toContain("1 error line(s) this check already reported before this request are left out");
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
