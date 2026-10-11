import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { configuration } from "../src/clients/cli.ts";
import { formatClaudeStatus } from "../src/clients/statusline.ts";
import { callTool, fileDiff, listDirectory, previewFile, workspaceStatus } from "../src/clients/workspace.ts";
import { parseGitSnapshot } from "../src/git-status.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const entry = path.join(root, "src/clients/cli.ts");
const signal = () => new AbortController().signal;
function git(cwd: string, ...args: string[]) {
	return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

async function fixture(t: test.TestContext, repository = true) {
	const cwd = await mkdtemp(path.join(tmpdir(), "midnight-native-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	if (repository) {
		git(cwd, "init", "--quiet", "--initial-branch=main");
		git(cwd, "config", "user.name", "Midnight test");
		git(cwd, "config", "user.email", "midnight@example.invalid");
		git(cwd, "config", "core.autocrlf", "false");
	}
	return cwd;
}

test("native Git tools keep staged/unstaged layers and report current disk changes", async (t) => {
	const cwd = await fixture(t);
	await writeFile(path.join(cwd, "file.txt"), "base\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "--quiet", "-m", "base");
	await writeFile(path.join(cwd, "file.txt"), "staged\n");
	git(cwd, "add", ".");
	await writeFile(path.join(cwd, "file.txt"), "working\n");
	await writeFile(path.join(cwd, "[file] ü.txt"), "new content\n");
	git(cwd, "config", "diff.external", "midnight-must-not-execute-external-diff");
	const status = await workspaceStatus({ cwd }, signal());
	assert.equal(status.available, true);
	assert.equal(status.branch, "main");
	assert.deepEqual(status.summary, { staged: 1, unstaged: 1, untracked: 1, conflicted: 0, changedFiles: 2 });
	const staged = await fileDiff({ cwd, path: "file.txt", layer: "staged" }, signal());
	assert.ok(staged.items.some((line) => line.text === "-base"));
	assert.ok(staged.items.some((line) => line.text === "+staged"));
	const unstaged = await fileDiff({ cwd, path: "file.txt" }, signal());
	assert.ok(unstaged.items.some((line) => line.text === "-staged"));
	assert.ok(unstaged.items.some((line) => line.text === "+working"));
	const untracked = await fileDiff({ cwd, path: "[file] ü.txt" }, signal());
	assert.match(untracked.comparison, /untracked/);
	assert.equal(untracked.items[0].text, "+new content");
	git(cwd, "restore", "--staged", "--worktree", "file.txt");
	await rm(path.join(cwd, "[file] ü.txt"));
	const clean = await workspaceStatus({ cwd }, signal());
	assert.equal(clean.available, true);
	assert.equal(clean.summary?.changedFiles, 0);
});

test("native Git handles unborn HEAD, deletion, rename endpoints and non-Git folders", async (t) => {
	const cwd = await fixture(t);
	await writeFile(path.join(cwd, "old.txt"), "original\n");
	git(cwd, "add", ".");
	const unborn = await fileDiff({ cwd, path: "old.txt", layer: "staged" }, signal());
	assert.ok(unborn.items.some((line) => line.text === "+original"));
	git(cwd, "commit", "--quiet", "-m", "base");
	git(cwd, "mv", "old.txt", "renamed.txt");
	const renamed = await fileDiff({ cwd, path: "old.txt", layer: "staged" }, signal());
	assert.ok(renamed.items.some((line) => line.text === "rename to renamed.txt"));
	await rm(path.join(cwd, "renamed.txt"));
	const deletion = await fileDiff({ cwd, path: "renamed.txt" }, signal());
	assert.ok(deletion.items.some((line) => line.text === "-original"));
	const outside = await fixture(t, false);
	assert.equal((await workspaceStatus({ cwd: outside }, signal())).available, false);
	await assert.rejects(fileDiff({ cwd: outside, path: "absent.txt" }, signal()), /No Git baseline/);
});

test("native diffs report ignored folders, binary files and conflicts explicitly", async (t) => {
	const cwd = await fixture(t);
	await writeFile(path.join(cwd, ".gitignore"), "ignored/\n");
	await writeFile(path.join(cwd, "conflict.txt"), "base\n");
	await writeFile(path.join(cwd, "binary"), Buffer.from([0, 1]));
	git(cwd, "add", ".");
	git(cwd, "commit", "--quiet", "-m", "base");
	await mkdir(path.join(cwd, "ignored"));
	await writeFile(path.join(cwd, "ignored/file.txt"), "ignored\n");
	await assert.rejects(fileDiff({ cwd, path: "ignored/file.txt" }, signal()), /Ignored file/);
	await writeFile(path.join(cwd, "binary"), Buffer.from([0, 2]));
	assert.ok((await fileDiff({ cwd, path: "binary" }, signal())).items.some((line) => /Binary files/.test(line.text)));
	git(cwd, "checkout", "--quiet", "-b", "other");
	await writeFile(path.join(cwd, "conflict.txt"), "other\n");
	git(cwd, "add", "conflict.txt");
	git(cwd, "commit", "--quiet", "-m", "other");
	git(cwd, "checkout", "--quiet", "main");
	await writeFile(path.join(cwd, "conflict.txt"), "main\n");
	git(cwd, "add", "conflict.txt");
	git(cwd, "commit", "--quiet", "-m", "main");
	assert.throws(() => git(cwd, "merge", "other"));
	await assert.rejects(fileDiff({ cwd, path: "conflict.txt" }, signal()), /Unresolved conflict/);
});

test("directory and preview tools paginate, sanitize terminal text and bound reads", async (t) => {
	const cwd = await fixture(t, false);
	await mkdir(path.join(cwd, "dir"));
	await writeFile(path.join(cwd, ".hidden"), "secret-free fixture");
	await writeFile(path.join(cwd, "file2.txt"), "first\n\u001b[31mred\u001b[0m\nthird\n");
	await writeFile(path.join(cwd, "file10.txt"), "ten\n");
	const first = await listDirectory({ cwd, limit: 2 }, signal());
	assert.equal(first.items[0].type, "directory");
	assert.equal(first.nextOffset, 2);
	const second = await listDirectory({ cwd, offset: 2, limit: 2 }, signal());
	assert.deepEqual(
		second.items.map((item) => item.name),
		["file2.txt", "file10.txt"],
	);
	assert.equal(second.nextOffset, null);
	const preview = await previewFile({ cwd, path: "file2.txt", offset: 1, limit: 1 }, signal());
	assert.deepEqual(preview.items, [{ line: 2, text: "red" }]);
	assert.equal(preview.nextOffset, 2);
	await writeFile(path.join(cwd, "binary"), Buffer.from([0, 1, 2]));
	await assert.rejects(previewFile({ cwd, path: "binary" }, signal()), /Binary/);
	await writeFile(path.join(cwd, "large"), Buffer.alloc(1024 * 1024 + 1, 65));
	await assert.rejects(previewFile({ cwd, path: "large" }, signal()), /Too large/);
	await writeFile(path.join(cwd, "long-line"), "x".repeat(49 * 1024));
	await assert.rejects(previewFile({ cwd, path: "long-line" }, signal()), /display limit/);
	await assert.rejects(callTool("midnight_list", { cwd, limit: -1 }, signal()), /limit/);
	await assert.rejects(callTool("midnight_preview", { cwd }, signal()), /path/);
	await assert.rejects(callTool("midnight_status", { cwd, surprise: true }, signal()), /Unknown argument/);
});

test("file tools reject traversal and escaping junctions without changing the process directory", async (t) => {
	const cwd = await fixture(t, false);
	const outside = await fixture(t, false);
	await writeFile(path.join(outside, "outside.txt"), "outside\n");
	const original = process.cwd();
	await assert.rejects(previewFile({ cwd, path: path.join(outside, "outside.txt") }, signal()), /leaves cwd/);
	await assert.rejects(listDirectory({ cwd, path: ".." }, signal()), /leaves cwd/);
	await symlink(outside, path.join(cwd, "link"), process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(listDirectory({ cwd, path: "link" }, signal()), /leaves cwd/);
	await assert.rejects(previewFile({ cwd, path: "link/outside.txt" }, signal()), /leaves cwd/);
	assert.equal(process.cwd(), original);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(listDirectory({ cwd }, controller.signal), /abort/i);
});

test("Claude status line preserves zero and unavailable values without invented speed", () => {
	const git = parseGitSnapshot("# branch.head main\0? new.txt\0");
	const value = {
		workspace: { current_dir: root },
		model: { display_name: "Claude\u001b[2J" },
		session_name: "Native plugins\nsecond line",
		context_window: { used_percentage: 0, total_input_tokens: 1200, total_output_tokens: 0 },
		cost: { total_cost_usd: 0 },
	};
	const line = formatClaudeStatus(value, git);
	assert.equal(line.split("\n").length, 2);
	assert.match(line, /main \| Claude \| Native plugins second line/);
	assert.match(line, /ctx 0\.0%/);
	assert.match(line, /context in 1,200/);
	assert.match(line, /last out 0/);
	assert.match(line, /est \$0\.00/);
	assert.ok(!line.includes("\u001b"));
	assert.doesNotMatch(line, /TTFT|tok\/s/);
	assert.equal(formatClaudeStatus(null), "Midnight\nGit unavailable");
});

type Rpc = { id?: number | string | null; result?: Record<string, unknown>; error?: { code: number } };
function mcpClient(t: test.TestContext, args = ["--experimental-strip-types", entry, "mcp"]) {
	const child = spawn(process.execPath, args, { windowsHide: true });
	const messages: Rpc[] = [];
	const waiting = new Map<number | string, { resolve: (value: Rpc) => void; reject: (cause: Error) => void }>();
	let stderr = "";
	child.stderr.on("data", (data) => {
		stderr += data;
	});
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		const message = JSON.parse(line) as Rpc;
		messages.push(message);
		if (message.id !== undefined && message.id !== null) {
			waiting.get(message.id)?.resolve(message);
			waiting.delete(message.id);
		}
	});
	child.on("exit", () => {
		for (const promise of waiting.values()) promise.reject(new Error(`MCP exited: ${stderr}`));
	});
	t.after(() => {
		child.kill();
		lines.close();
	});
	const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
	async function request(id: number, method: string, params?: unknown) {
		const result = new Promise<Rpc>((resolve, reject) => {
			waiting.set(id, { resolve, reject });
		});
		send({ jsonrpc: "2.0", id, method, params });
		return result;
	}
	return { child, messages, send, request, stderr: () => stderr };
}

test(
	"MCP performs real stdio discovery, reads, errors, cancellation and clean shutdown",
	{ timeout: 20_000 },
	async (t) => {
		const cwd = await fixture(t, false);
		await writeFile(path.join(cwd, "ü file.txt"), "hello\n");
		const client = mcpClient(t);
		const init = await client.request(1, "initialize", {
			protocolVersion: "2099-01-01",
			capabilities: {},
			clientInfo: { name: "test", version: "1" },
		});
		assert.equal(init.result?.protocolVersion, "2025-06-18");
		client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		const listed = await client.request(2, "tools/list");
		assert.equal((listed.result?.tools as unknown[]).length, 4);
		const preview = await client.request(3, "tools/call", {
			name: "midnight_preview",
			arguments: { cwd, path: "ü file.txt" },
		});
		const content = preview.result?.content as { text: string }[];
		assert.equal(JSON.parse(content[0].text).items[0].text, "hello");
		const invalid = await client.request(4, "tools/call", {
			name: "midnight_preview",
			arguments: { cwd, path: "missing" },
		});
		assert.equal(invalid.result?.isError, true);
		assert.equal((await client.request(5, "tools/call", { name: "unknown", arguments: {} })).error?.code, -32602);
		assert.equal((await client.request(6, "unknown")).error?.code, -32601);
		const cancelled = client.request(7, "tools/call", { name: "midnight_status", arguments: { cwd } });
		client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
		assert.equal((await cancelled).result?.isError, true);
		assert.ok(client.messages.every((message) => message.id !== undefined));
		const exit = once(client.child, "exit");
		client.child.stdin.end();
		assert.equal((await exit)[0], 0);
		assert.equal(client.stderr(), "");
	},
);

test("MCP rejects oversized input instead of buffering without limit", { timeout: 10_000 }, async (t) => {
	const client = mcpClient(t);
	const exit = once(client.child, "exit");
	client.child.stdin.write("x".repeat(65537));
	await exit;
	assert.equal(client.messages[0]?.error?.code, -32700);
});

test(
	"packaged native tools run without Pi or node_modules, and generated Claude config executes",
	{ timeout: 20_000 },
	async (t) => {
		const cwd = await fixture(t, false);
		const packageDir = path.join(cwd, "plugin's $literal & path");
		await mkdir(packageDir);
		for (const file of ["src/clients", "src/git-status.ts", "src/session-pending-io.ts", "package.json"])
			await cp(path.join(root, file), path.join(packageDir, file), { recursive: true });
		const script = path.join(packageDir, "src/clients/cli.ts");
		const listed = JSON.parse(
			(await run(process.execPath, ["--experimental-strip-types", script, "list", "--cwd", packageDir])).stdout,
		);
		assert.equal(listed.directory, packageDir);
		const command = JSON.parse(configuration("claude", script)).statusLine.command as string;
		const executable = process.platform === "win32" ? "powershell.exe" : "sh";
		const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-c", command];
		const child = execFile(executable, args, { windowsHide: true }, () => {});
		let output = "";
		let errors = "";
		child.stdout?.on("data", (data) => {
			output += data;
		});
		child.stderr?.on("data", (data) => {
			errors += data;
		});
		const exit = once(child, "exit");
		child.stdin?.end(JSON.stringify({ model: { display_name: "Fixture model" } }));
		assert.equal((await exit)[0], 0, errors);
		assert.match(output, /Midnight \| Fixture model/);
		for (const [manifest, variable] of [
			[".mcp.json", "CLAUDE_PLUGIN_ROOT"],
			["mcp.json", "PLUGIN_ROOT"],
		]) {
			const source = await readFile(path.join(root, manifest), "utf8");
			const server = JSON.parse(source).mcpServers.midnight;
			const configured = server.args.map((arg: string) => arg.replaceAll(`\${${variable}}`, packageDir));
			const client = mcpClient(t, configured);
			assert.ok((await client.request(1, "initialize", { protocolVersion: "2025-06-18" })).result);
			const response = await client.request(2, "tools/call", {
				name: "midnight_list",
				arguments: { cwd: packageDir },
			});
			assert.equal(response.result?.isError, undefined);
			assert.ok((response.result?.content as { text: string }[])[0].text.includes("package.json"));
		}
	},
);
