import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SideThreadStore, sideThreadFileFor } from "../src/core/side-threads.ts";

describe("export HTML side threads", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	it("embeds the session's side threads and renders them under their items", async () => {
		const dir = mkdtempSync(join(tmpdir(), "export-side-threads-"));
		dirs.push(dir);
		const session = SessionManager.create(dir, dir);
		session.appendMessage({ role: "user", content: "run the checks", timestamp: 1 });
		session.appendMessage(
			fauxAssistantMessage([fauxToolCall("bash", { command: "npm run check" }, { id: "call-1" })]),
		);
		const sessionFile = session.getSessionFile()!;

		const store = new SideThreadStore(sideThreadFileFor(sessionFile));
		store.getOrCreate("tool:call-1", "bash npm run check", "output").turns.push({
			question: "is it only lint?",
			answer: "Yes, **lint only**.",
			model: { provider: "midnight", id: "minicpm5-2b-q8_0", kind: "local" },
			status: "done",
			startedAt: 1,
			finishedAt: 2,
		});
		store.save();

		const outputPath = await exportFromFile(sessionFile, join(dir, "out.html"));
		const html = readFileSync(outputPath, "utf8");
		const base64 = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(html)?.[1] ?? "";
		const data = JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as {
			sideThreads: Array<{ anchorId: string; turns: Array<{ question: string }> }>;
		};
		expect(data.sideThreads).toHaveLength(1);
		expect(data.sideThreads[0]).toMatchObject({ anchorId: "tool:call-1" });
		expect(data.sideThreads[0]?.turns[0]?.question).toBe("is it only lint?");
		expect(html).toContain("renderSideThread(`tool:");
		expect(html).toContain(".side-thread-body");
	});
});
