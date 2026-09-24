#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModelLock, verifyModelFile } from "../packages/coding-agent/src/midnight/model-integrity.ts";

const defaultLock = fileURLToPath(new URL("../models/minicpm5-2b-q8_0.lock.json", import.meta.url));
const args = process.argv.slice(2);
const usage = "Usage: node scripts/verify-model.mjs <model.gguf> [--lock <manifest.json>]";

try {
	if (args.length !== 1 && (args.length !== 3 || args[1] !== "--lock" || !args[2])) {
		throw new Error(usage);
	}
	const path = resolve(args[0]);
	const lock = await loadModelLock(args[2] ? resolve(args[2]) : defaultLock);
	await verifyModelFile(path, lock);
	console.log(`Verified ${path} (${lock.sizeBytes} bytes, SHA-256 ${lock.sha256})`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
