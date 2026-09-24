import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { loadModelLock, type ModelLock, verifyModelFile } from "../src/midnight/model-integrity.ts";

const lockPath = fileURLToPath(new URL("../../../models/minicpm5-2b-q8_0.lock.json", import.meta.url));
const verifyScript = fileURLToPath(new URL("../../../scripts/verify-model.mjs", import.meta.url));
const tempDirs: string[] = [];

async function fixture(contents: string): Promise<{ path: string; lock: ModelLock; lockFile: string }> {
	const dir = await mkdtemp(join(tmpdir(), "midnight-model-"));
	tempDirs.push(dir);
	const path = join(dir, "model.gguf");
	const lockFile = join(dir, "lock.json");
	const lock: ModelLock = {
		modelId: "openbmb/MiniCPM5-2B",
		repository: "openbmb/MiniCPM5-2B-GGUF",
		revision: "2079a22f3beaa4e306449978533478fe0522f4b3",
		fileName: "model.gguf",
		sizeBytes: Buffer.byteLength(contents),
		sha256: createHash("sha256").update(contents).digest("hex"),
	};
	await writeFile(path, contents);
	await writeFile(lockFile, JSON.stringify(lock));
	return { path, lock, lockFile };
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("model lock", () => {
	test("records the pinned MiniCPM Q8 artifact without claiming it was downloaded", async () => {
		const lock = await loadModelLock(lockPath);
		expect(lock).toEqual({
			modelId: "openbmb/MiniCPM5-2B",
			repository: "openbmb/MiniCPM5-2B-GGUF",
			revision: "2079a22f3beaa4e306449978533478fe0522f4b3",
			fileName: "MiniCPM5-2B-Q8_0.gguf",
			sizeBytes: 2679710688,
			sha256: "c5415f8989bf88a8288f1b55a3cc371af53c07b0faa220a63bd7a990cfaba078",
		});
	});

	test("rejects malformed metadata and non-local filenames", async () => {
		const { lockFile, lock } = await fixture("sample");
		for (const invalid of [
			{ ...lock, fileName: "../model.gguf" },
			{ ...lock, sizeBytes: -1 },
			{ ...lock, sha256: "unknown" },
			{ ...lock, revision: "main" },
			[],
		]) {
			await writeFile(lockFile, JSON.stringify(invalid));
			await expect(loadModelLock(lockFile)).rejects.toThrow("Invalid model lock");
		}
	});
});

describe("model verification", () => {
	test("accepts a complete matching file and the standalone verifier", async () => {
		const { path, lock, lockFile } = await fixture("model fixture");
		await expect(verifyModelFile(path, await loadModelLock(lockFile))).resolves.toBeUndefined();
		const result = spawnSync(process.execPath, [verifyScript, path, "--lock", lockFile], { encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(lock.sha256);
	});

	test("rejects a truncated file before hashing", async () => {
		const { path, lock } = await fixture("complete");
		await writeFile(path, "short");
		await expect(verifyModelFile(path, lock)).rejects.toThrow("Model size mismatch");
	});

	test("rejects same-sized corruption", async () => {
		const { path, lock, lockFile } = await fixture("correct");
		await writeFile(path, "corrupt");
		await expect(verifyModelFile(path, lock)).rejects.toThrow("Model SHA-256 mismatch");
		const result = spawnSync(process.execPath, [verifyScript, path, "--lock", lockFile], { encoding: "utf8" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("SHA-256 mismatch");
	});

	test("rejects missing files and honours cancellation", async () => {
		const { path, lock } = await fixture("sample");
		await expect(verifyModelFile(`${path}.missing`, lock)).rejects.toThrow();
		const controller = new AbortController();
		controller.abort();
		await expect(verifyModelFile(path, lock, controller.signal)).rejects.toThrow();
	});

	test("does not modify the verified file", async () => {
		const { path, lock } = await fixture("unchanged");
		await verifyModelFile(path, lock);
		expect(await readFile(path, "utf8")).toBe("unchanged");
	});
});
