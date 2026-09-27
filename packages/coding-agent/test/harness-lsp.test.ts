import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverServer, LspManager } from "../src/harness/lsp.ts";
import { newErrors, runLookup } from "../src/harness/semantic.ts";
import { buildWorkspaceIndex } from "../src/harness/workspace-index.ts";

/**
 * Runs against language servers installed on the machine; each case is skipped when its
 * server is missing. Nothing is downloaded.
 */
const probeRoot = mkdtempSync(join(tmpdir(), "harness-lsp-probe-"));
const hasPyright = discoverServer(join(probeRoot, "a.py"), probeRoot) !== undefined;
const hasTypeScript = discoverServer(join(probeRoot, "a.ts"), probeRoot) !== undefined;
rmSync(probeRoot, { recursive: true, force: true });

describe("language servers", () => {
	let root: string;
	let manager: LspManager;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "harness-lsp-"));
		manager = new LspManager(root);
	});
	afterEach(async () => {
		await manager.dispose();
		rmSync(root, { recursive: true, force: true });
	});

	it.skipIf(!hasPyright)(
		"reports a new Python type error after an edit and finds references",
		async () => {
			mkdirSync(join(root, "pkg"));
			writeFileSync(join(root, "pkg", "__init__.py"), "");
			const lib = join(root, "pkg", "lib.py");
			writeFileSync(lib, "def parse_port(value: str) -> int:\n    return int(value)\n");
			writeFileSync(join(root, "main.py"), "from pkg.lib import parse_port\n\nprint(parse_port('80'))\n");
			const client = await manager.clientFor(lib);
			expect(client?.spec.id).toBe("python");

			const since = Date.now();
			client!.sync(lib);
			const before = await client!.diagnosticsFor(lib, since, 20_000);
			expect(before).toBeDefined();

			const broken = "def parse_port(value: str) -> int:\n    return value.nosuch()\n";
			const editAt = Date.now();
			client!.sync(lib, broken);
			const after = await client!.diagnosticsFor(lib, editAt, 20_000);
			expect(newErrors(before, after ?? []).length).toBeGreaterThan(0);

			client!.sync(lib, "def parse_port(value: str) -> int:\n    return int(value)\n");
			const index = buildWorkspaceIndex(root);
			const references = await runLookup({ op: "references", symbol: "parse_port" }, index, manager);
			expect(references).toContain("main.py");
		},
		60_000,
	);

	it.skipIf(!hasTypeScript)(
		"outlines and references TypeScript through the language server",
		async () => {
			writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
			writeFileSync(
				join(root, "port.ts"),
				"export function parsePort(value: string): number {\n  return Number(value);\n}\n",
			);
			writeFileSync(join(root, "main.ts"), "import { parsePort } from './port';\nparsePort('80');\n");
			const index = buildWorkspaceIndex(root);
			const outline = await runLookup({ op: "outline", path: "port.ts" }, index, manager);
			expect(outline).toContain("parsePort");
			const references = await runLookup({ op: "references", symbol: "parsePort" }, index, manager);
			expect(references).toContain("main.ts:");
		},
		60_000,
	);
});
