import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import harnessExtension from "../../src/harness/extension.ts";
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
			...(options.escalationModel ? { escalation: { model: options.escalationModel } } : {}),
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

	it("sends a context pack with the ranked file's contents in the first request", async () => {
		const harness = await setup();
		writeFileSync(join(harness.tempDir, "port.js"), "function parsePort(value) {\n  return Number(value);\n}\n");
		writeFileSync(join(harness.tempDir, "other.js"), "function unrelated() {}\n");
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

	it("runs checks after an edit during the run and tells the model they pass", async () => {
		const harness = await setup();
		writeProject(harness.tempDir);
		let secondRequest = "";
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
				secondRequest = contextText(context);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("add a comment to value.js");
		expect(secondRequest).toContain("Harness checks after your edits pass");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("restores the last passing state after the same check fails twice", async () => {
		const harness = await setup();
		writeProject(harness.tempDir);
		initGit(harness.tempDir);
		const file = join(harness.tempDir, "value.js");
		const edit = (from: string, to: string) =>
			fauxAssistantMessage([fauxToolCall("edit", { path: "value.js", edits: [{ oldText: from, newText: to }] })], {
				stopReason: "toolUse",
			});
		let rollbackMessage = "";
		harness.setResponses([
			// Good edit: in-run check passes, the harness snapshots this state.
			edit("module.exports = 1;", "module.exports = 1; // v2"),
			// Bad edit in the next turn: in-run check fails.
			edit("module.exports = 1; // v2", "module.exports = 2; // v3"),
			fauxAssistantMessage("done"),
			// Settle check fails (round 1); another bad fix.
			edit("module.exports = 2; // v3", "module.exports = 3; // v4"),
			fauxAssistantMessage("done again"),
			// Settle check fails again (round 2, repeated): rollback.
			(context) => {
				rollbackMessage = contextText(context);
				return fauxAssistantMessage("understood");
			},
		]);
		await harness.session.prompt("change value.js");
		expect(rollbackMessage).toContain("restored value.js to the last state in this request where the checks passed");
		expect(rollbackMessage).toContain("-module.exports = 1; // v2");
		expect(readFileSync(file, "utf8")).toBe("module.exports = 1; // v2\n");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("never rolls back to a state from an earlier request or touches files the agent did not edit", async () => {
		const harness = await setup();
		writeProject(harness.tempDir);
		writeFileSync(join(harness.tempDir, "README.md"), "original readme\n");
		initGit(harness.tempDir);
		const file = join(harness.tempDir, "value.js");
		const edit = (from: string, to: string) =>
			fauxAssistantMessage([fauxToolCall("edit", { path: "value.js", edits: [{ oldText: from, newText: to }] })], {
				stopReason: "toolUse",
			});
		// Request 1: checks pass and the harness snapshots that state.
		harness.setResponses([edit("module.exports = 1;", "module.exports = 1; // v2"), fauxAssistantMessage("done")]);
		await harness.session.prompt("comment value.js");

		// The user works between requests.
		writeFileSync(join(harness.tempDir, "notes.txt"), "user notes\n");
		writeFileSync(join(harness.tempDir, "README.md"), "user edited readme\n");

		// Request 2: the same check fails twice, with no passing state in this request.
		let feedback = "";
		harness.setResponses([
			edit("module.exports = 1; // v2", "module.exports = 2;"),
			fauxAssistantMessage("done"),
			edit("module.exports = 2;", "module.exports = 3;"),
			fauxAssistantMessage("done again"),
			(context) => {
				feedback = contextText(context);
				return fauxAssistantMessage("understood");
			},
		]);
		await harness.session.prompt("set value to 2");
		expect(feedback).toContain("Harness checks");
		expect(feedback).not.toContain("restored");
		expect(readFileSync(file, "utf8")).toBe("module.exports = 3;\n");
		expect(readFileSync(join(harness.tempDir, "notes.txt"), "utf8")).toBe("user notes\n");
		expect(readFileSync(join(harness.tempDir, "README.md"), "utf8")).toBe("user edited readme\n");
	});

	it("rolls back only the files the agent edited", async () => {
		const harness = await setup();
		writeProject(harness.tempDir);
		initGit(harness.tempDir);
		const edit = (from: string, to: string) =>
			fauxAssistantMessage([fauxToolCall("edit", { path: "value.js", edits: [{ oldText: from, newText: to }] })], {
				stopReason: "toolUse",
			});
		harness.setResponses([
			edit("module.exports = 1;", "module.exports = 1; // v2"),
			// The user saves a file in their editor while the agent works.
			() => {
				writeFileSync(join(harness.tempDir, "notes.txt"), "user notes\n");
				return edit("module.exports = 1; // v2", "module.exports = 2;");
			},
			fauxAssistantMessage("done"),
			edit("module.exports = 2;", "module.exports = 3;"),
			fauxAssistantMessage("done again"),
			fauxAssistantMessage("understood"),
		]);
		await harness.session.prompt("change value.js");
		expect(readFileSync(join(harness.tempDir, "value.js"), "utf8")).toBe("module.exports = 1; // v2\n");
		expect(readFileSync(join(harness.tempDir, "notes.txt"), "utf8")).toBe("user notes\n");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("asks the escalation model for advice when the same check keeps failing", async () => {
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
			// Round 1 feedback; the model tries the same thing.
			fauxAssistantMessage("still done"),
			// Round 2 fails the same check: the harness consults the strong model first.
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
		expect(adviceSeen).toContain("Advice from faux/strong");
		expect(adviceSeen).toContain("Root cause: value.js must export 1");
	});

	describe("independent review by a local Laya server", () => {
		let server: Server;
		let noul = 0.9;
		const states: unknown[] = [];
		const saved = process.env.MIDNIGHT_SERVER_LAYA_URL;
		const savedFeatures = process.env.MIDNIGHT_SERVER_HARNESS_FEATURES;
		afterEach(() => {
			server?.close();
			if (saved === undefined) delete process.env.MIDNIGHT_SERVER_LAYA_URL;
			else process.env.MIDNIGHT_SERVER_LAYA_URL = saved;
			if (savedFeatures === undefined) delete process.env.MIDNIGHT_SERVER_HARNESS_FEATURES;
			else process.env.MIDNIGHT_SERVER_HARNESS_FEATURES = savedFeatures;
		});

		async function startFakeLaya(): Promise<void> {
			server = createServer((req, res) => {
				let body = "";
				req.on("data", (chunk) => {
					body += chunk;
				});
				req.on("end", () => {
					const request = JSON.parse(body) as { state: unknown; questions: Record<string, { type: string }> };
					states.push(request.state);
					const answers: Record<string, unknown> = {};
					for (const [name, question] of Object.entries(request.questions)) {
						// Only the "does it do what was asked" question varies; the rest look clean.
						if (question.type === "noul")
							answers[name] = { type: "noul", noul: name === "addresses_request" ? noul : 0.05 };
						else
							answers[name] = { type: "score", score: 0, confidence: 0.9, legend: {}, probabilities: { 0: 1 } };
					}
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ model: "laya-fake", answers, usage: { input_tokens: 1, output_tokens: 1 } }));
				});
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			process.env.MIDNIGHT_SERVER_LAYA_URL = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
			// The review is off by default (evals/laya-review); these tests turn it on.
			process.env.MIDNIGHT_SERVER_HARNESS_FEATURES = "+decisions";
		}

		const editValue = () =>
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "value.js",
						edits: [{ oldText: "module.exports = 1;", newText: "module.exports = 1; // x" }],
					}),
				],
				{ stopReason: "toolUse" },
			);

		it("gives one revision turn when the review judges the change incomplete", async () => {
			noul = 0.1;
			await startFakeLaya();
			const harness = await setup();
			writeProject(harness.tempDir);
			let reviewSeen = "";
			harness.setResponses([
				editValue(),
				fauxAssistantMessage("Done, all good."),
				(context) => {
					reviewSeen = contextText(context);
					return fauxAssistantMessage("Rechecked the request; the change covers it.");
				},
			]);
			await harness.session.prompt("add a comment to value.js");
			expect(reviewSeen).toContain("An independent review of your change");
			expect(reviewSeen).toContain("addresses_request 10%");
			expect(harness.getPendingResponseCount()).toBe(0);
			const reviewed = states.at(-1) as { request: string; final_message: string; change: { diff: string } };
			expect(reviewed.request).toBe("add a comment to value.js");
			expect(reviewed.final_message).toBe("Done, all good.");
			expect(reviewed.change.diff).toContain("+module.exports = 1; // x");
		});

		it("accepts without an extra turn when the review is favorable", async () => {
			noul = 0.9;
			await startFakeLaya();
			const harness = await setup();
			writeProject(harness.tempDir);
			harness.setResponses([editValue(), fauxAssistantMessage("Done.")]);
			await harness.session.prompt("add a comment to value.js");
			expect(harness.getPendingResponseCount()).toBe(0);
		});
	});
});
