import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";

export interface ModelLock {
	modelId: string;
	repository: string;
	revision: string;
	fileName: string;
	sizeBytes: number;
	sha256: string;
}

export async function loadModelLock(path: string): Promise<ModelLock> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Invalid model lock: ${path}`);
	}
	const lock = value as Record<string, unknown>;
	if (
		typeof lock.modelId !== "string" ||
		!/^[-\w]+\/[-\w]+$/.test(lock.modelId) ||
		typeof lock.repository !== "string" ||
		!/^[-\w]+\/[-\w]+$/.test(lock.repository) ||
		typeof lock.revision !== "string" ||
		!/^[0-9a-f]{40}$/.test(lock.revision) ||
		typeof lock.fileName !== "string" ||
		!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.gguf$/.test(lock.fileName) ||
		typeof lock.sizeBytes !== "number" ||
		!Number.isSafeInteger(lock.sizeBytes) ||
		lock.sizeBytes <= 0 ||
		typeof lock.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(lock.sha256)
	) {
		throw new Error(`Invalid model lock: ${path}`);
	}
	return {
		modelId: lock.modelId,
		repository: lock.repository,
		revision: lock.revision,
		fileName: lock.fileName,
		sizeBytes: lock.sizeBytes,
		sha256: lock.sha256,
	};
}

/** Verify an existing file before it is promoted to the model store or passed to an engine. */
export async function verifyModelFile(path: string, lock: ModelLock, signal?: AbortSignal): Promise<void> {
	const before = await stat(path);
	if (!before.isFile() || before.size !== lock.sizeBytes) {
		throw new Error(`Model size mismatch: expected ${lock.sizeBytes} bytes at ${path}, found ${before.size}`);
	}

	const hash = createHash("sha256");
	let bytesRead = 0;
	for await (const chunk of createReadStream(path, { signal })) {
		bytesRead += chunk.length;
		hash.update(chunk);
	}
	const after = await stat(path);
	if (bytesRead !== lock.sizeBytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
		throw new Error(`Model changed during verification: ${path}`);
	}
	if (hash.digest("hex") !== lock.sha256) {
		throw new Error(`Model SHA-256 mismatch: ${path}`);
	}
}
