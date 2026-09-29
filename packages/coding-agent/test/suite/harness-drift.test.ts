import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { BLOCKER_GUIDELINE } from "../../src/harness/drift.ts";
import harnessExtension from "../../src/harness/extension.ts";
import { createHarness, type Harness } from "./harness.ts";

function contextText(context: Context): string {
	return JSON.stringify(context);
}

/** A git project with source, a test and a passing check (`node test.js`). */
function writeProject(dir: string, options: { checks?: boolean; maxRepairRounds?: number } = {}): void {
	writeFileSync(
		join(dir, "port.js"),
		"function parsePort(value) {\n\treturn Number(value);\n}\nmodule.exports = { parsePort };\n",
	);
	writeFileSync(
		join(dir, "test.js"),
		'const assert = require("node:assert");\nconst { parsePort } = require("./port.js");\nassert.strictEqual(parsePort("8080"), 8080);\nassert.strictEqual(parsePort("abc"), undefined);\n',
	);
	mkdirSync(join(dir, ".midnight.server"), { recursive: true });
	writeFileSync(
		join(dir, ".midnight.server", "harness.json"),
		JSON.stringify({
			checks: options.checks === false ? [] : [{ name: "unit", command: ["node", "test.js"], when: ["*.js"] }],
			autoChecks: false,
			...(options.maxRepairRounds !== undefined ? { maxRepairRounds: options.maxRepairRounds } : {}),
		}),
	);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	git("init", "-q");
	git("add", "-A");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start");
}

const edit = (path: string, oldText: string, newText: string) =>
	fauxAssistantMessage([fauxToolCall("edit", { path, edits: [{ oldText, newText }] })], { stopReason: "toolUse" });

const FIXED_SOURCE = [
	"function parsePort(value) {",
	"\tconst port = Number(value);",
	"\treturn Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;",
	"}",
].join("\n");

describe("drift guard in a session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(): Promise<Harness> {
		const harness = await createHarness({ extensionFactories: [{ name: "harness", factory: harnessExtension }] });
		harnesses.push(harness);
		harness.settingsManager.setProjectTrusted(true);
		return harness;
	}

	it("asks once to fix or disclose when a test assertion is commented out", async () => {
		const harness = await setup();
		writeProject(harness.tempDir);
		let feedback = "";
		harness.setResponses([
			edit(
				"test.js",
				'assert.strictEqual(parsePort("abc"), undefined);',
				'// assert.strictEqual(parsePort("abc"), undefined);',
			),
			fauxAssistantMessage("Done. All tests pass."),
			(context) => {
				feedback = contextText(context);
				return fauxAssistantMessage("I could not make parsePort reject junk yet; the test is still commented out.");
			},
		]);
		await harness.session.prompt("parsePort in port.js must return undefined for invalid ports");
		expect(feedback).toContain("possible implementation drift");
		expect(feedback).toContain("assertion removed or commented out");
		// One fix-or-disclose turn, then the run settles even though the drift remains.
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not interrupt a correct change that the checks verified", async () => {
		const harness = await setup();
		writeProject(harness.tempDir);
		let calls = 0;
		harness.setResponses([
			edit("port.js", "function parsePort(value) {\n\treturn Number(value);\n}", FIXED_SOURCE),
			() => {
				calls++;
				return fauxAssistantMessage("Done. All tests pass.");
			},
			() => {
				calls++;
				return fauxAssistantMessage("unexpected extra turn");
			},
		]);
		await harness.session.prompt("parsePort in port.js must return undefined for invalid ports");
		expect(calls).toBe(1);
	});

	it("sees edits made outside the edit tools, such as by a shell command", async () => {
		const harness = await setup();
		writeProject(harness.tempDir);
		// What a `sed -i` would do: no edit tool call, the file just changes.
		writeFileSync(
			join(harness.tempDir, "shrink.js"),
			`require("fs").writeFileSync("test.js", ${JSON.stringify('const assert = require("node:assert");\nconst { parsePort } = require("./port.js");\nassert.strictEqual(parsePort("8080"), 8080);\n')});\n`,
		);
		const shell = process.platform === "win32" ? "powershell" : "bash";
		let feedback = "";
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(shell, { command: "node shrink.js" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Removed the failing case."),
			(context) => {
				feedback = contextText(context);
				return fauxAssistantMessage("That test encoded the request; I removed it and the request is not done.");
			},
		]);
		await harness.session.prompt("parsePort in port.js must return undefined for invalid ports");
		expect(feedback).toContain("test.js: 1 assertion removed");
	});

	it("flags a success claim that no check or test run supports", async () => {
		const harness = await setup();
		writeProject(harness.tempDir, { checks: false });
		let feedback = "";
		harness.setResponses([
			edit("port.js", "function parsePort(value) {\n\treturn Number(value);\n}", FIXED_SOURCE),
			fauxAssistantMessage("Fixed parsePort. All tests pass."),
			(context) => {
				feedback = contextText(context);
				return fauxAssistantMessage("Fixed parsePort. I did not run the tests.");
			},
		]);
		await harness.session.prompt("parsePort in port.js must return undefined for invalid ports");
		expect(feedback).toContain("no check or test command succeeded after the last change");
	});

	it("tells the model the request wins over a contradicting test, and stops repairing once it reports the conflict", async () => {
		const harness = await setup();
		writeProject(harness.tempDir);
		// The test contradicts the request below: it expects junk to parse as NaN-free 0.
		writeFileSync(
			join(harness.tempDir, "test.js"),
			'const assert = require("node:assert");\nconst { parsePort } = require("./port.js");\nassert.strictEqual(parsePort("8080"), 8080);\nassert.strictEqual(parsePort("abc"), 0);\n',
		);
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "conflict"], {
			cwd: harness.tempDir,
			stdio: "ignore",
		});
		let feedback = "";
		let extraTurns = 0;
		harness.setResponses([
			edit("port.js", "function parsePort(value) {\n\treturn Number(value);\n}", FIXED_SOURCE),
			fauxAssistantMessage("Done."),
			(context) => {
				feedback = contextText(context);
				return fauxAssistantMessage(
					'parsePort now returns undefined for invalid ports as requested. test.js still expects parsePort("abc") to be 0, which contradicts the request, so that test fails.',
				);
			},
			() => {
				extraTurns++;
				return fauxAssistantMessage("unexpected extra repair turn");
			},
		]);
		await harness.session.prompt("parsePort in port.js must return undefined for invalid ports");
		expect(feedback).toContain("the request wins");
		expect(extraTurns).toBe(0);
	});

	it("keeps repairing when the model does not report why the checks fail", async () => {
		const harness = await setup();
		writeProject(harness.tempDir, { maxRepairRounds: 2 });
		let rounds = 0;
		harness.setResponses([
			edit("port.js", "\treturn Number(value);", "\treturn Number(value) + 1;"),
			fauxAssistantMessage("Done."),
			() => {
				rounds++;
				return fauxAssistantMessage("Done again.");
			},
			() => {
				rounds++;
				return fauxAssistantMessage("Done once more.");
			},
		]);
		await harness.session.prompt("parsePort in port.js must return undefined for invalid ports");
		expect(rounds).toBe(2);
	});

	it("offers the blocker rule in the system prompt", async () => {
		const harness = await setup();
		writeProject(harness.tempDir);
		let withRule = "";
		harness.setResponses([
			(context) => {
				withRule = contextText(context);
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("hello");
		expect(withRule).toContain(BLOCKER_GUIDELINE.slice(0, 60));
	});
});
