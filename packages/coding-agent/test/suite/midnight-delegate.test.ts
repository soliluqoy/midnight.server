import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatRequest, ChatResult, LocalEngine } from "../../src/midnight/engine.ts";
import type { EngineManager } from "../../src/midnight/engine-manager.ts";
import { createDelegateExtension } from "../../src/midnight/extension.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

function scriptedManager(reply: string): { manager: EngineManager; requests: ChatRequest[] } {
	const requests: ChatRequest[] = [];
	const engine = {
		async chat(request: ChatRequest): Promise<ChatResult> {
			requests.push(request);
			return { content: reply, finishReason: "stop", promptTokens: 20, completionTokens: 10 };
		},
	} as unknown as LocalEngine;
	const manager = { get: async () => engine, touch() {}, stop: async () => {} } as unknown as EngineManager;
	return { manager, requests };
}

describe("hybrid delegation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("lets the parent model delegate a read-only task and receive a validated result", async () => {
		const { manager, requests } = scriptedManager(
			JSON.stringify({
				status: "completed",
				summary: "add() returns the sum.",
				evidence: [{ path: "math.ts", startLine: 1, endLine: 1 }],
			}),
		);
		const harness = await createHarness({ extensionFactories: [createDelegateExtension(manager)] });
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
		harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), "delegate_local"]);

		let toolText = "";
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("delegate_local", {
						kind: "summarize",
						instruction: "What does add do?",
						paths: ["math.ts"],
					}),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				const result = context.messages.find((message) => message.role === "toolResult");
				toolText = JSON.stringify(result);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("summarize math.ts");

		expect(getAssistantTexts(harness)).toContain("done");
		expect(requests).toHaveLength(1);
		expect(requests[0].messages[1].content).toContain("export const add");
		expect(toolText).toContain("completed");
		expect(toolText).toContain("math.ts:1");
	});

	it("returns an error result when the parent names a file outside the workspace", async () => {
		const { manager, requests } = scriptedManager("{}");
		const harness = await createHarness({ extensionFactories: [createDelegateExtension(manager)] });
		harnesses.push(harness);
		harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), "delegate_local"]);

		let toolResult: unknown;
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("delegate_local", { kind: "inspect", instruction: "read it", paths: ["../../etc/passwd"] })],
				{ stopReason: "toolUse" },
			),
			(context) => {
				toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("go");

		expect(requests).toHaveLength(0);
		expect(toolResult).toMatchObject({ isError: true });
	});

	it("runs a read-only git op named by the parent and includes its output", async () => {
		const { manager, requests } = scriptedManager(
			JSON.stringify({ status: "completed", summary: "one file changed.", evidence: [] }),
		);
		const harness = await createHarness({ extensionFactories: [createDelegateExtension(manager)] });
		harnesses.push(harness);
		harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), "delegate_local"]);

		const gitOptions = { cwd: harness.tempDir, stdio: "ignore" as const };
		execFileSync("git", ["init", "-q"], gitOptions);
		execFileSync("git", ["config", "user.email", "test@example.com"], gitOptions);
		execFileSync("git", ["config", "user.name", "Test"], gitOptions);
		writeFileSync(join(harness.tempDir, "a.ts"), "export const a = 1;\n");
		execFileSync("git", ["add", "a.ts"], gitOptions);
		execFileSync("git", ["commit", "-q", "-m", "first"], gitOptions);
		writeFileSync(join(harness.tempDir, "a.ts"), "export const a = 2;\n");

		let toolText = "";
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("delegate_local", { kind: "inspect", instruction: "what changed?", git: { op: "diff" } })],
				{ stopReason: "toolUse" },
			),
			(context) => {
				const result = context.messages.find((message) => message.role === "toolResult");
				toolText = JSON.stringify(result);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("review the diff");

		// The answer, then the one-token self-check on the same prefix.
		expect(requests).toHaveLength(2);
		expect(requests[0].messages[1].content).toContain('<git op="diff">');
		expect(requests[1].grammar).toBe('root ::= "yes" | "no"');
		expect(toolText).toContain("completed");
	});
});
