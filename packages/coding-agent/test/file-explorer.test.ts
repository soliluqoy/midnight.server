import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	createFileSystemSnapshot,
	markFromStatusCode,
	parseGitStatus,
	readWorkspaceSnapshot,
} from "../src/core/workspace-files.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { FileExplorerComponent } from "../src/modes/interactive/components/file-explorer.ts";
import { FilePreviewComponent, loadFilePreview } from "../src/modes/interactive/components/file-preview.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => {
	initTheme(undefined, false);
	setKeybindings(new KeybindingsManager());
});

const workspaces: string[] = [];
afterEach(() => {
	for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Create a temporary workspace containing `files` (paths with `/`; a trailing `/` makes an empty folder). */
function makeWorkspace(files: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "explorer-"));
	workspaces.push(root);
	for (const file of files) {
		if (file.endsWith("/")) {
			mkdirSync(join(root, file), { recursive: true });
			continue;
		}
		mkdirSync(join(root, file, ".."), { recursive: true });
		writeFileSync(join(root, file), "");
	}
	return root;
}

describe("workspace files", () => {
	it("maps porcelain codes to one mark, preferring the working tree", () => {
		expect(markFromStatusCode("??")).toBe("?");
		expect(markFromStatusCode(" M")).toBe("M");
		expect(markFromStatusCode("A ")).toBe("A");
		expect(markFromStatusCode("AM")).toBe("M");
		expect(markFromStatusCode(" D")).toBe("D");
		expect(markFromStatusCode("R ")).toBe("R");
		expect(markFromStatusCode("UU")).toBe("U");
		expect(markFromStatusCode("AA")).toBe("U");
	});

	it("parses status paths relative to the workspace prefix and skips rename sources", () => {
		const output = [
			" M pkg/src/a.ts",
			"R  pkg/new.ts",
			"pkg/old.ts",
			"?? pkg/notes.md",
			"!! pkg/dist/",
			"!! pkg/.env",
			" M other/b.ts",
			"",
		].join("\0");
		const { marks, ignored } = parseGitStatus(output, "pkg/");
		expect([...marks]).toEqual([
			["src/a.ts", "M"],
			["new.ts", "R"],
			["notes.md", "?"],
		]);
		expect([...ignored]).toEqual(["dist", ".env"]);
	});

	it("lists directories first, then files, and marks folders that contain changes", () => {
		const root = makeWorkspace(["README.md", "src/b.ts", "src/a.ts", "src/lib/c.ts", "docs/x.md"]);
		const snapshot = createFileSystemSnapshot(root, { marks: new Map([["src/lib/c.ts", "M"]]), ignored: new Set() });
		expect(snapshot.children("").map((entry) => entry.name)).toEqual(["docs", "src", "README.md"]);
		expect(snapshot.children("src").map((entry) => entry.path)).toEqual(["src/lib", "src/a.ts", "src/b.ts"]);
		expect(snapshot.mark("src/lib/c.ts")).toBe("M");
		expect(snapshot.containsMarks("src")).toBe(true);
		expect(snapshot.containsMarks("src/lib")).toBe(true);
		expect(snapshot.containsMarks("docs")).toBe(false);
	});

	it("lists everything, including ignored files, node_modules and .git", () => {
		const root = makeWorkspace([".git/", "node_modules/pkg/index.js", "dist/out.js", ".gitignore", "src/a.ts"]);
		writeFileSync(join(root, ".gitignore"), "dist\nnode_modules\n");
		const snapshot = createFileSystemSnapshot(root);
		expect(snapshot.children("").map((entry) => entry.name)).toEqual([
			".git",
			"dist",
			"node_modules",
			"src",
			".gitignore",
		]);
		expect(snapshot.children("node_modules/pkg")).toEqual([
			{ name: "index.js", path: "node_modules/pkg/index.js", directory: false },
		]);
	});

	it("treats paths inside an ignored folder, and .git, as ignored", () => {
		const snapshot = createFileSystemSnapshot(makeWorkspace([]), {
			marks: new Map(),
			ignored: new Set(["node_modules", "src/gen.ts"]),
		});
		expect(snapshot.isIgnored("node_modules")).toBe(true);
		expect(snapshot.isIgnored("node_modules/pkg/index.js")).toBe(true);
		expect(snapshot.isIgnored("src/gen.ts")).toBe(true);
		expect(snapshot.isIgnored(".git/HEAD")).toBe(true);
		expect(snapshot.isIgnored("src")).toBe(false);
		expect(snapshot.isIgnored("src/a.ts")).toBe(false);
	});

	it("reads ignored folders from git once, not file by file", async () => {
		const root = makeWorkspace(["node_modules/pkg/index.js", "node_modules/pkg/lib.js", "src/a.ts", ".gitignore"]);
		writeFileSync(join(root, ".gitignore"), "node_modules/\n");
		execFileSync("git", ["init", "-q"], { cwd: root });
		const snapshot = await readWorkspaceSnapshot(root);
		expect(snapshot.isIgnored("node_modules/pkg/index.js")).toBe(true);
		expect(snapshot.isIgnored("src/a.ts")).toBe(false);
		expect(snapshot.mark("src/a.ts")).toBe("?");
		expect(snapshot.children("").map((entry) => entry.name)).toEqual([".git", "node_modules", "src", ".gitignore"]);
	});
});

describe("file explorer", () => {
	const ENTER = "\r";
	const DOWN = "\x1b[B";
	const RIGHT = "\x1b[C";
	const LEFT = "\x1b[D";
	const ESCAPE = "\x1b";

	function createExplorer(files = ["src/a.ts", "src/b.ts", "README.md"], ignored = new Set<string>()) {
		const calls: string[] = [];
		const explorer = new FileExplorerComponent({
			rootName: () => "repo",
			sessionChanges: () => new Set(["src/a.ts"]),
			getHeight: () => 12,
			onOpen: (path) => calls.push(`open ${path}`),
			onPreview: (path) => calls.push(`preview ${path}`),
			onExit: () => calls.push("exit"),
			onToggle: () => calls.push("toggle"),
			onPassthrough: (data) => calls.push(`pass ${data}`),
		});
		const root = makeWorkspace(files);
		explorer.setSnapshot(createFileSystemSnapshot(root, { marks: new Map([["src/b.ts", "M"]]), ignored }));
		return { explorer, calls };
	}

	it("fills the column at a fixed width with a right border", () => {
		const { explorer } = createExplorer();
		const lines = explorer.render(32);
		expect(lines).toHaveLength(12);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(32);
			expect(stripAnsi(line).endsWith("│")).toBe(true);
		}
		const text = lines.map(stripAnsi).join("\n");
		expect(text).toContain("EXPLORER repo");
		expect(text).toContain("▸ src");
		expect(text).toContain("README.md");
	});

	it("expands folders and opens, previews, and marks files", () => {
		const { explorer, calls } = createExplorer();
		explorer.render(32);
		explorer.handleInput(RIGHT);
		const expanded = explorer.render(32).map(stripAnsi).join("\n");
		expect(expanded).toContain("▾ src");
		expect(expanded).toMatch(/a\.ts\s+●/);
		expect(expanded).toMatch(/b\.ts\s+M/);

		explorer.handleInput(DOWN);
		expect(explorer.getSelectedPath()).toBe("src/a.ts");
		explorer.handleInput(ENTER);
		explorer.handleInput(" ");
		explorer.handleInput(RIGHT);
		expect(calls).toEqual(["open src/a.ts", "preview src/a.ts", "preview src/a.ts"]);

		explorer.handleInput(LEFT);
		expect(explorer.getSelectedPath()).toBe("src");
		explorer.handleInput(LEFT);
		expect(explorer.render(32).map(stripAnsi).join("\n")).toContain("▸ src");
	});

	it("dims ignored entries but still previews and opens them", () => {
		const { explorer, calls } = createExplorer(["src/a.ts", "dist/out.js"], new Set(["dist"]));
		explorer.render(32);
		// dist sorts first; expand it and select out.js.
		explorer.handleInput(RIGHT);
		explorer.handleInput(DOWN);
		expect(explorer.getSelectedPath()).toBe("dist/out.js");
		const lines = explorer.render(32);
		const outLine = lines.find((line) => stripAnsi(line).includes("out.js"))!;
		const srcLine = lines.find((line) => stripAnsi(line).includes("src"))!;
		const dim = theme.fg("dim", "x").split("x")[0]!;
		expect(outLine).toContain(`${dim}out.js`);
		expect(srcLine).not.toContain(`${dim}src`);
		explorer.handleInput(" ");
		explorer.handleInput(ENTER);
		expect(calls).toEqual(["preview dist/out.js", "open dist/out.js"]);
	});

	it("passes typing through to the prompt and exits on escape", () => {
		const { explorer, calls } = createExplorer();
		explorer.handleInput("f");
		explorer.handleInput(ESCAPE);
		explorer.handleInput("\x1be");
		expect(calls).toEqual(["pass f", "exit", "toggle"]);
	});

	it("selects on click, toggles folders, and opens files on double click", () => {
		const { explorer, calls } = createExplorer();
		explorer.render(32);
		const click = (y: number, clickCount = 1) =>
			explorer.handleMouse({
				type: "click",
				button: "left",
				x: 4,
				y,
				screenX: 4,
				screenY: y,
				width: 32,
				height: 12,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount,
			});
		// Row 2 is the first tree row, below the title and a blank line.
		expect(click(2)).toEqual({ handled: true, focus: true });
		explorer.render(32);
		expect(explorer.getSelectedPath()).toBe("src");
		click(3);
		expect(calls).toEqual([]);
		click(3, 2);
		expect(calls).toEqual(["open src/a.ts"]);
	});
});

describe("file preview", () => {
	it("loads text, and refuses binary and missing files", () => {
		const root = makeWorkspace([]);
		writeFileSync(join(root, "a.txt"), "one\r\ntwo\n");
		writeFileSync(join(root, "b.bin"), Buffer.from([1, 0, 2]));
		expect(loadFilePreview(join(root, "a.txt"))).toEqual({ kind: "text", lines: ["one", "two"] });
		expect(loadFilePreview(join(root, "b.bin"))).toEqual({ kind: "message", text: "Binary file." });
		expect(loadFilePreview(join(root, "missing.txt")).kind).toBe("message");
	});

	it("renders a bordered box of the requested height and scrolls", () => {
		const lines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
		const calls: string[] = [];
		const preview = new FilePreviewComponent({
			path: "src/a.ts",
			content: { kind: "text", lines },
			getHeight: () => 10,
			onInsert: () => calls.push("insert"),
			onClose: () => calls.push("close"),
		});
		const first = preview.render(60);
		expect(first).toHaveLength(10);
		for (const line of first) expect(visibleWidth(line)).toBe(60);
		expect(stripAnsi(first[0]!)).toContain("src/a.ts");
		expect(stripAnsi(first[1]!)).toContain(" 1 line 1");
		preview.handleInput("\x1b[B");
		expect(stripAnsi(preview.render(60)[1]!)).toContain(" 2 line 2");
		preview.handleInput("\r");
		preview.handleInput("\x1b");
		expect(calls).toEqual(["insert", "close"]);
	});
});

describe("chat viewport explorer column", () => {
	it("places the explorer left of the transcript and the sidebar right of it", () => {
		const column = (text: string) => ({
			render: (width: number) => [text.padEnd(width, ".")],
			invalidate: () => {},
		});
		const viewport = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			explorer: { component: column("E"), width: 5, visible: () => true },
			sidebar: { component: column("S"), width: 4, visible: () => true },
		});
		const line = stripAnsi(viewport.root.render(40)[0] ?? "");
		expect(line.startsWith("E....")).toBe(true);
		expect(line.endsWith("S...")).toBe(true);
	});
});
