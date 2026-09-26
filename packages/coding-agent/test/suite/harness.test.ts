import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import harnessExtension, { CHECK_MESSAGE_TYPE, CONTRACT_MESSAGE_TYPE } from "../../src/harness/extension.ts";
import { createHarness, type Harness } from "./harness.ts";

/** A check that passes only when `answer.txt` contains "good". */
const CHECK = {
	name: "answer",
	command: [
		process.execPath,
		"-e",
		"const fs=require('fs');const ok=fs.existsSync('answer.txt')&&fs.readFileSync('answer.txt','utf8').includes('good');console.log(ok?'ok':'answer.txt must contain good');process.exit(ok?0:1)",
	],
	when: ["*.txt"],
};

async function harnessWith(config: Record<string, unknown> = {}): Promise<Harness> {
	const harness = await createHarness({ extensionFactories: [harnessExtension] });
	mkdirSync(join(harness.tempDir, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(join(harness.tempDir, CONFIG_DIR_NAME, "harness.json"), JSON.stringify(config));
	await harness.session.bindExtensions({ shutdownHandler: () => {} });
	return harness;
}

function customMessages(harness: Harness, customType: string): string[] {
	return harness.session.messages.flatMap((message) =>
		message.role === "custom" && message.customType === customType
			? [typeof message.content === "string" ? message.content : JSON.stringify(message.content)]
			: [],
	);
}

describe("harness", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("runs checks before settling and feeds a failure back for one repair round", async () => {
		const harness = await harnessWith({ checks: [CHECK], contract: false });
		harnesses.push(harness);
		const requests: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "answer.txt", content: "bad" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage(fauxToolCall("write", { path: "answer.txt", content: "good" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("fixed"),
		]);

		await harness.session.prompt("write the answer");

		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("Harness checks failed after your changes (repair round 1 of 2)");
		expect(requests[0]).toContain("answer.txt must contain good");
		expect(readFileSync(join(harness.tempDir, "answer.txt"), "utf8")).toBe("good");
		expect(customMessages(harness, CHECK_MESSAGE_TYPE)).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("stops after the configured repair rounds and reports", async () => {
		const harness = await harnessWith({ checks: [CHECK], contract: false, maxRepairRounds: 1 });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "answer.txt", content: "bad" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage(fauxToolCall("write", { path: "answer.txt", content: "still bad" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done again"),
		]);

		await harness.session.prompt("write the answer");

		const messages = customMessages(harness, CHECK_MESSAGE_TYPE);
		expect(messages).toHaveLength(2);
		expect(messages[1]).toContain("still fail after 1 repair round(s); stopping here");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not run checks when nothing changed", async () => {
		const harness = await harnessWith({ checks: [CHECK], contract: false });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("just an answer")]);
		await harness.session.prompt("explain");
		expect(customMessages(harness, CHECK_MESSAGE_TYPE)).toEqual([]);
	});

	it("blocks edits to protected files and to its own config", async () => {
		const harness = await harnessWith({ protect: ["tests/**"], contract: false });
		harnesses.push(harness);
		const results: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("write", { path: "tests/spec.txt", content: "weakened" }),
					fauxToolCall("write", { path: `${CONFIG_DIR_NAME}/harness.json`, content: "{}" }),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				for (const message of context.messages) {
					if (message.role === "toolResult") results.push(JSON.stringify(message.content));
				}
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("go");

		expect(results).toHaveLength(2);
		expect(results.every((text) => text.includes("protected by the harness"))).toBe(true);
		expect(existsSync(join(harness.tempDir, "tests", "spec.txt"))).toBe(false);
	});

	it("holds the run to open acceptance criteria once, then settles", async () => {
		const harness = await harnessWith();
		harnesses.push(harness);
		const requests: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					action: "set",
					objective: "Answer the question",
					criteria: ["answer cites the source"],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("here is the answer"),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage(
					fauxToolCall("task", {
						action: "update",
						mark: [{ id: 1, status: "met", evidence: "cited README.md line 3" }],
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("verified"),
		]);

		await harness.session.prompt("answer it");

		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("1. answer cites the source");
		expect(customMessages(harness, CONTRACT_MESSAGE_TYPE)).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("rejects update before set and marking without evidence", async () => {
		const harness = await harnessWith();
		harnesses.push(harness);
		const results: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { action: "update", mark: [] }), { stopReason: "toolUse" }),
			(context) => {
				for (const message of context.messages) {
					if (message.role === "toolResult") results.push(JSON.stringify(message));
				}
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("go");
		expect(results[0]).toContain("No task contract yet");
		expect(results[0]).toContain('"isError":true');
	});

	it("elides old large tool results in one batch through context edits", async () => {
		const harness = await harnessWith({
			contract: false,
			masking: { keepRecentResults: 1, minResultBytes: 1_000, batchBytes: 5_000 },
		});
		harnesses.push(harness);
		for (const name of ["a", "b", "c"]) writeFileSync(join(harness.tempDir, `${name}.txt`), name.repeat(3_000));
		const requests: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "a.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read", { path: "b.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read", { path: "c.txt" }), { stopReason: "toolUse" }),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("read them");

		const edits = harness.sessionManager.getEntries().filter((entry) => entry.type === "context_edit");
		expect(edits).toHaveLength(2);
		expect(requests[0]).toContain('read {\\"path\\":\\"a.txt\\"} output elided');
		expect(requests[0]).not.toContain("a".repeat(3_000));
		expect(requests[0]).toContain("c".repeat(3_000));
	});

	it("is inert when disabled", async () => {
		const harness = await harnessWith({ enabled: false, checks: [CHECK] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "answer.txt", content: "bad" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(customMessages(harness, CHECK_MESSAGE_TYPE)).toEqual([]);
		expect(harness.session.getActiveToolNames()).not.toContain("task");
	});
});

describe("harness interface repair", () => {
	it("remaps an invented absolute path and tells the model", async () => {
		const harness = await harnessWith({ contract: false });
		writeFileSync(join(harness.tempDir, "math.js"), "module.exports = 1;\n");
		const results: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "/no-such-root-7f3a/math.js" }), { stopReason: "toolUse" }),
			(context) => {
				for (const message of context.messages) {
					if (message.role === "toolResult") results.push(JSON.stringify(message));
				}
				return fauxAssistantMessage("ok");
			},
		]);
		try {
			await harness.session.prompt("read math.js");
			expect(results[0]).toContain("used math.js in the workspace");
			expect(results[0]).toContain("module.exports = 1;");
			expect(results[0]).toContain('"isError":false');
		} finally {
			harness.cleanup();
		}
	});
});
