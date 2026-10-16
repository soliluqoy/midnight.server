import { isUtf8 } from "node:buffer";
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TUI } from "@earendil-works/pi-tui";

const MAX_EDIT_BYTES = 1024 * 1024;
const SUPPORTED = new Set(["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]);

export function bundledMicro(platform = process.platform, arch = process.arch): string | undefined {
	const target = `${platform}-${arch}`;
	if (!SUPPORTED.has(target)) return undefined;
	return fileURLToPath(
		new URL(`../vendor/micro/${target}/${platform === "win32" ? "micro.exe" : "micro"}`, import.meta.url),
	);
}

export async function editableFileError(path: string): Promise<string | undefined> {
	try {
		const entry = await lstat(path);
		if (!entry.isFile()) return "Only regular files can be edited (symlinks are not supported).";
		if ((entry.mode & 0o222) === 0) return "File is read-only.";
		if (entry.size > MAX_EDIT_BYTES) return "File is too large to edit (limit: 1 MiB).";
		const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stats = await file.stat();
			if (!stats.isFile() || stats.size > MAX_EDIT_BYTES) return "File is not a supported regular file.";
			const buffer = Buffer.alloc(MAX_EDIT_BYTES + 1);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			if (bytesRead > MAX_EDIT_BYTES) return "File is too large to edit (limit: 1 MiB).";
			const bytes = buffer.subarray(0, bytesRead);
			if (bytes.includes(0) || !isUtf8(bytes)) return "Only UTF-8 text files can be edited.";
		} finally {
			await file.close();
		}
		await access(path, constants.W_OK);
		return undefined;
	} catch (error) {
		return `Cannot edit file: ${error instanceof Error ? error.message : String(error)}`;
	}
}

export async function readyMicroBinary(
	binary: string,
	platform = process.platform,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
	if (platform === "win32") {
		await access(binary, constants.F_OK);
		return { path: binary, cleanup: async () => {} };
	}
	try {
		await access(binary, constants.X_OK);
		return { path: binary, cleanup: async () => {} };
	} catch {
		// npm archives made on Windows may drop Unix execute bits. Do not mutate a read-only installation.
		const directory = await mkdtemp(join(tmpdir(), "midnight-micro-"));
		try {
			const path = join(directory, "micro");
			await copyFile(binary, path);
			await chmod(path, 0o700);
			await access(path, constants.X_OK);
			return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
		} catch (error) {
			await rm(directory, { recursive: true, force: true });
			throw error;
		}
	}
}

export type MicroTerminal = Pick<TUI, "stop" | "start" | "requestRender">;
export type MicroSpawn = (binary: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Windows Terminal parses semicolons as command separators, so file paths travel only inside an encoded script. */
export async function openMicroWindow(
	binary: string,
	file: string,
	cwd: string,
	launch: MicroSpawn = spawn,
): Promise<void> {
	const decode = (value: string) =>
		`[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString("base64")}'))`;
	const script = `Set-Location -LiteralPath (${decode(cwd)}); & (${decode(binary)}) (${decode(file)}); exit $LASTEXITCODE`;
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	const args = [
		"-w",
		"new",
		"new-tab",
		"--title",
		"Micro",
		"powershell.exe",
		"-NoLogo",
		"-NoProfile",
		"-EncodedCommand",
		encoded,
	];
	const code = await new Promise<number | null>((resolve, reject) => {
		const child = launch("wt.exe", args, { cwd, stdio: "ignore", shell: false });
		child.once("error", reject);
		child.once("close", resolve);
	});
	if (code !== 0) throw new Error(`Windows Terminal did not open the Micro window (status ${code ?? "unknown"}).`);
}

/** Hand terminal ownership to Micro and always restore Pi, including on spawn failure. */
export async function runMicro(
	terminal: MicroTerminal,
	binary: string,
	file: string,
	cwd: string,
	launch: MicroSpawn = spawn,
): Promise<number | null> {
	terminal.stop();
	try {
		return await new Promise<number | null>((resolve, reject) => {
			const child = launch(binary, [file], { cwd, stdio: "inherit", shell: false });
			child.once("error", reject);
			child.once("close", (code) => resolve(code));
		});
	} finally {
		terminal.start();
		terminal.requestRender(true);
	}
}
