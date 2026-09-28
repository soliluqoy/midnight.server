import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import harnessExtension from "../../src/harness/extension.ts";
import { HarnessPolicyCore, LIVE_SUITE } from "../../src/lattice/harness-policy.ts";
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

function writeConfig(dir: string, config: Record<string, unknown>): void {
	mkdirSync(join(dir, ".midnight.server"), { recursive: true });
	writeFileSync(join(dir, ".midnight.server", "harness.json"), JSON.stringify(config));
}

const edit = (path: string, from: string, to: string) =>
	fauxAssistantMessage([fauxToolCall("edit", { path, edits: [{ oldText: from, newText: to }] })], {
		stopReason: "toolUse",
	});

describe("harness with the Lattice core", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	async function setup(models?: Array<{ id: string; reasoning?: boolean }>): Promise<Harness> {
		const harness = await createHarness({
			models,
			extensionFactories: [{ name: "harness", factory: harnessExtension }],
		});
		harnesses.push(harness);
		harness.settingsManager.setProjectTrusted(true);
		return harness;
	}

	it("names a repeated attempt, raises the thinking level while stuck, and restores it", async () => {
		const harness = await setup([{ id: "fast", reasoning: true }]);
		writeFileSync(join(harness.tempDir, "value.js"), "module.exports = 1;\n");
		writeFileSync(
			join(harness.tempDir, "check.js"),
			"if (require('./value.js') !== 1) { console.error('expected 1'); process.exit(1); }\n",
		);
		writeConfig(harness.tempDir, { checks: [{ name: "value", command: ["node", "check.js"], when: ["*.js"] }] });
		harness.session.setThinkingLevel("off");
		const levels: Array<string | undefined> = [];
		let stuckFeedback = "";
		harness.setResponses([
			(_context, options) => {
				levels.push(options?.reasoning);
				return edit("value.js", "module.exports = 1;", "module.exports = 2;");
			},
			(_context, options) => {
				levels.push(options?.reasoning);
				return fauxAssistantMessage("done");
			},
			// Round 1 feedback; the model ends again without a new idea: the same change as before.
			(_context, options) => {
				levels.push(options?.reasoning);
				return fauxAssistantMessage("done, it is correct");
			},
			// Round 2: the same checks, the same change.
			(context, options) => {
				levels.push(options?.reasoning);
				stuckFeedback = contextText(context);
				return fauxAssistantMessage("I cannot make value.js export 2 while check.js expects 1.");
			},
		]);
		await harness.session.prompt("set value to 2");
		expect(stuckFeedback).toContain("This attempt is 100% the same change as attempt 1");
		expect(stuckFeedback).toContain("Approaches the checks rejected in this request:");
		expect(stuckFeedback).toContain("1. value.js: `module.exports = 2;`");
		expect(stuckFeedback).toContain("2. value.js: `module.exports = 2;`");
		expect(stuckFeedback).toContain("name three causes that differ in kind");
		// The request that follows the stuck feedback thinks harder than the ones before it.
		expect(levels.slice(0, 3).every((level) => level === undefined || level === "off")).toBe(true);
		expect(levels[3]).toBe("low");
		// Back to the user's level once the run settles.
		expect(harness.session.thinkingLevel).toBe("off");
	});

	it("runs the verifier probe and reports a changed line no test pins, restoring the file", async () => {
		const harness = await setup();
		const port = join(harness.tempDir, "port.js");
		writeFileSync(port, "exports.valid = (n) => {\n\treturn true;\n};\n");
		writeFileSync(
			join(harness.tempDir, "test.js"),
			"const { valid } = require('./port.js');\nif (valid(-1) !== false || valid(0) !== true) process.exit(1);\n",
		);
		writeConfig(harness.tempDir, {
			checks: [{ name: "unit", command: ["node", "test.js"], when: ["*.js"], level: 2 }],
			protect: ["test.js"],
			features: { mutationProbe: true },
		});
		let probeFeedback = "";
		harness.setResponses([
			edit(
				"port.js",
				"\treturn true;",
				"\tif (n < 0) return false;\n\tif (n > 65535) return false;\n\treturn true;",
			),
			fauxAssistantMessage("Ports below 0 and above 65535 are now invalid."),
			(context) => {
				probeFeedback = contextText(context);
				return fauxAssistantMessage("The upper bound is not covered by a test; I did not change the tests.");
			},
		]);
		await harness.session.prompt("port.js: reject ports below 0 and above 65535");
		expect(probeFeedback).toContain("Verifier probe:");
		expect(probeFeedback).toContain(
			"port.js:3 (relational): `if (n > 65535) return false;` -> `if (n >= 65535) return false;`",
		);
		expect(probeFeedback).not.toContain("port.js:2 (relational)");
		expect(readFileSync(port, "utf8")).toBe(
			"exports.valid = (n) => {\n\tif (n < 0) return false;\n\tif (n > 65535) return false;\n\treturn true;\n};\n",
		);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("records each settled request as live evidence in the Lattice store", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "harness-lattice-"));
		dirs.push(dataDir);
		vi.stubEnv("MIDNIGHT_SERVER_HARNESS_LEARN", "1");
		vi.stubEnv("LATTICE_DATA", dataDir);
		const harness = await setup();
		writeFileSync(join(harness.tempDir, "value.js"), "module.exports = 1;\n");
		writeFileSync(join(harness.tempDir, "check.js"), "if (require('./value.js') !== 1) process.exit(1);\n");
		writeConfig(harness.tempDir, { checks: [{ name: "value", command: ["node", "check.js"], when: ["*.js"] }] });
		harness.setResponses([
			edit("value.js", "module.exports = 1;", "module.exports = 1; // ok"),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("comment value.js");
		harness.cleanup();
		harnesses.pop();
		const core = HarnessPolicyCore.open(dataDir);
		try {
			const rows = core.store.evaluationsOf(LIVE_SUITE);
			expect(rows).toHaveLength(1);
			expect(rows[0].verdict).toBe("resolved");
			expect(rows[0].program_hash).toBe(core.active().hash);
			expect(rows[0].metrics).toMatchObject({ checked: true, final_failed: false, model_class: "fast" });
		} finally {
			core.close();
		}
	});
});
