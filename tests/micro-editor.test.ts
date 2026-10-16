import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { test } from "node:test";
import { FileExplorerComponent } from "../src/file-explorer.ts";
import { createKeybindings } from "../src/keys.ts";
import {
	bundledMicro,
	editableFileError,
	type MicroTerminal,
	openMicroWindow,
	readyMicroBinary,
	runMicro,
} from "../src/micro-editor.ts";

test("bundled Micro resolves the six supported targets without a runtime download", () => {
	for (const platform of ["win32", "darwin", "linux"])
		for (const arch of ["x64", "arm64"])
			assert.match(bundledMicro(platform, arch) ?? "", new RegExp(`vendor[/\\\\]micro[/\\\\]${platform}-${arch}`));
	assert.equal(bundledMicro("freebsd", "x64"), undefined);
	assert.equal(bundledMicro("linux", "ia32"), undefined);
});

test("all bundled executables match the documented upstream binary hashes", async () => {
	const hashes = {
		"win32-x64": "77a8b925c885702b5605b4aebb8e77c7b15e5b03beeb14b7aa7e12b2b8d4ef3f",
		"win32-arm64": "b96b2edc75973caa4a44c5dc03e41dadd6c001c0e6c45eab508b501616ac61cf",
		"darwin-x64": "f3b5932edb0bfc0f442e4217659d36ada5f0942c91da20d97776c9d7472a28f1",
		"darwin-arm64": "3cce2e6e9e760c6d89889a0e029c71853b6b56cecbb31f0a43eeec35c027b347",
		"linux-x64": "2027f2e4698fa4e826523ad16b95c724bf808de479f10ec769cdd200437701b3",
		"linux-arm64": "e0b4a8234f0432474e7ee28e12ffac0fe3bd31f030ba51dc059caa2f3d6d8bfc",
	};
	for (const [target, expected] of Object.entries(hashes)) {
		const [platform, arch] = target.split("-");
		const binary = bundledMicro(platform, arch);
		assert.ok(binary);
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(binary)) hash.update(chunk);
		assert.equal(hash.digest("hex"), expected, target);
	}
});

test("editing rejects unsupported files and accepts bounded UTF-8 text", async () => {
	const directory = await mkdtemp(join(tmpdir(), "midnight-micro-"));
	try {
		const file = join(directory, "source.ts");
		await writeFile(file, "\tconst x = 1;\r\n");
		assert.equal(await editableFileError(file), undefined);
		await chmod(file, 0o444);
		assert.match((await editableFileError(file)) ?? "", /read-only/);
		await chmod(file, 0o666);
		await writeFile(file, Buffer.from([0xff]));
		assert.match((await editableFileError(file)) ?? "", /UTF-8/);
		await writeFile(file, Buffer.from([0]));
		assert.match((await editableFileError(file)) ?? "", /UTF-8/);
		await writeFile(file, Buffer.alloc(1024 * 1024 + 1, 65));
		assert.match((await editableFileError(file)) ?? "", /too large/);
		assert.match((await editableFileError(directory)) ?? "", /regular files/);
		assert.match((await editableFileError(join(directory, "missing"))) ?? "", /Cannot edit/);
		try {
			const link = join(directory, "link");
			await symlink(file, link);
			assert.match((await editableFileError(link)) ?? "", /symlinks/);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("bundled executable staging never modifies the package", async () => {
	const directory = await mkdtemp(join(tmpdir(), "midnight-micro-bin-"));
	try {
		const binary = join(directory, "micro");
		await writeFile(binary, "executable placeholder");
		if (process.platform !== "win32") await chmod(binary, 0o644);
		const prepared = await readyMicroBinary(binary, process.platform);
		if (process.platform !== "win32") assert.notEqual(prepared.path, binary);
		await prepared.cleanup();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Windows Terminal requests a new Micro window without exposing paths to its command parser", async () => {
	const binary = "C:\\Program Files\\midnight\\micro.exe";
	const file = "C:\\é folder\\one; & 'two'.ts";
	const cwd = "C:\\project";
	const launch = (command: string, args: string[], options: { cwd?: string; stdio?: unknown; shell?: boolean }) => {
		assert.equal(command, "wt.exe");
		assert.deepEqual(args.slice(0, 9), [
			"-w",
			"new",
			"new-tab",
			"--title",
			"Micro",
			"powershell.exe",
			"-NoLogo",
			"-NoProfile",
			"-EncodedCommand",
		]);
		assert.equal(options.cwd, cwd);
		assert.equal(options.stdio, "ignore");
		assert.equal(options.shell, false);
		assert.ok(!args.some((arg) => arg.includes(file)));
		const script = Buffer.from(args[9], "base64").toString("utf16le");
		assert.deepEqual(
			[...script.matchAll(/FromBase64String\('([^']+)'\)/g)].map((match) => Buffer.from(match[1], "base64").toString()),
			[cwd, binary, file],
		);
		const child = new EventEmitter();
		queueMicrotask(() => child.emit("close", 0));
		return child as ChildProcess;
	};
	await openMicroWindow(binary, file, cwd, launch);
	await assert.rejects(
		() =>
			openMicroWindow(binary, file, cwd, () => {
				const child = new EventEmitter();
				queueMicrotask(() => child.emit("close", 1));
				return child as ChildProcess;
			}),
		/status 1/,
	);
});

test("Micro inherits terminal I/O, passes a literal path, and restores Pi on exit or error", async () => {
	const calls: string[] = [];
	const terminal: MicroTerminal = {
		stop: () => calls.push("stop"),
		start: () => calls.push("start"),
		requestRender: () => {
			calls.push("render");
		},
	};
	const file = "C:\\a folder\\x;name.ts";
	const launch = (binary: string, args: string[], options: { cwd?: string; stdio?: unknown; shell?: boolean }) => {
		assert.equal(binary, "micro.exe");
		assert.deepEqual(args, [file]);
		assert.equal(options.cwd, "C:\\project");
		assert.equal(options.stdio, "inherit");
		assert.equal(options.shell, false);
		const child = new EventEmitter();
		queueMicrotask(() => child.emit("close", 0));
		return child as ChildProcess;
	};
	assert.equal(await runMicro(terminal, "micro.exe", file, "C:\\project", launch), 0);
	assert.deepEqual(calls, ["stop", "start", "render"]);
	calls.length = 0;
	await assert.rejects(
		() =>
			runMicro(terminal, "missing", file, "C:\\project", () => {
				throw new Error("spawn failed");
			}),
		/spawn failed/,
	);
	assert.deepEqual(calls, ["stop", "start", "render"]);
	calls.length = 0;
	await assert.rejects(
		() =>
			runMicro(terminal, "missing", file, "C:\\project", () => {
				const child = new EventEmitter();
				queueMicrotask(() => child.emit("error", new Error("async spawn failed")));
				return child as ChildProcess;
			}),
		/async spawn failed/,
	);
	assert.deepEqual(calls, ["stop", "start", "render"]);
});

test("Space edits, Right previews and Enter inserts the selected file", () => {
	const actions: string[] = [];
	const explorer = new FileExplorerComponent({
		theme: () => {
			throw new Error("not rendered");
		},
		keybindings: createKeybindings(),
		rootPath: () => parse(process.cwd()).root,
		isProjectRoot: () => true,
		sessionChanges: () => new Set(),
		getHeight: () => 24,
		onExpand: () => {},
		onOpen: (path) => actions.push(`open:${path}`),
		onPreview: (path) => actions.push(`preview:${path}`),
		onEdit: (path) => actions.push(`edit:${path}`),
		onFolder: () => {},
		onParent: () => {},
		onProject: () => {},
		onExit: () => {},
		onToggle: () => {},
		onPassthrough: () => {},
	});
	explorer.setSnapshot({
		children: () => [{ name: "source.ts", path: "source.ts", directory: false }],
		mark: () => undefined,
		containsMarks: () => false,
		isIgnored: () => false,
	});
	explorer.handleInput(" ");
	explorer.handleInput("\x1b[C");
	explorer.handleInput("\r");
	assert.deepEqual(actions, ["edit:source.ts", "preview:source.ts", "open:source.ts"]);
});
