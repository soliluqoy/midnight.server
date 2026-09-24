import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadVerified, withFileLock } from "../src/midnight/download.ts";

const payload = Buffer.from("0123456789".repeat(1000));
const expected = { sizeBytes: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };

let dir: string;
let server: Server;
let url: string;
let requests: Array<string | undefined>;
let body: Buffer;
let honorRange: boolean;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "midnight-download-"));
	requests = [];
	body = payload;
	honorRange = true;
	server = createServer((request, response) => {
		const range = request.headers.range;
		requests.push(range);
		const match = range && honorRange ? /^bytes=(\d+)-$/.exec(range) : null;
		if (match) {
			const start = Number(match[1]);
			response.writeHead(206, { "Content-Length": body.length - start });
			response.end(body.subarray(start));
			return;
		}
		response.writeHead(200, { "Content-Length": body.length });
		response.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.gguf`;
});

afterEach(async () => {
	await new Promise((resolve) => server.close(resolve));
	await rm(dir, { recursive: true, force: true });
});

describe("verified download", () => {
	it("downloads, verifies, and promotes atomically", async () => {
		const dest = join(dir, "model.gguf");
		const progress: number[] = [];
		await downloadVerified(url, dest, expected, { onProgress: (p) => progress.push(p.receivedBytes) });
		expect(await readFile(dest)).toEqual(payload);
		expect(existsSync(`${dest}.part`)).toBe(false);
		expect(existsSync(`${dest}.lock`)).toBe(false);
		expect(progress.at(-1)).toBe(payload.length);
	});

	it("resumes a partial download with a range request", async () => {
		const dest = join(dir, "model.gguf");
		await writeFile(`${dest}.part`, payload.subarray(0, 4000));
		await downloadVerified(url, dest, expected);
		expect(requests).toEqual(["bytes=4000-"]);
		expect(await readFile(dest)).toEqual(payload);
	});

	it("restarts when the server ignores the range", async () => {
		honorRange = false;
		const dest = join(dir, "model.gguf");
		await writeFile(`${dest}.part`, Buffer.from("garbage!"));
		await downloadVerified(url, dest, expected);
		expect(await readFile(dest)).toEqual(payload);
	});

	it("never promotes corrupted content", async () => {
		body = Buffer.from(payload);
		body[10] = 0;
		const dest = join(dir, "model.gguf");
		await expect(downloadVerified(url, dest, expected)).rejects.toThrow(/SHA-256/);
		expect(existsSync(dest)).toBe(false);
		expect(existsSync(`${dest}.part`)).toBe(false);
	});

	it("stops a response that is larger than expected", async () => {
		body = Buffer.concat([payload, Buffer.from("extra")]);
		const dest = join(dir, "model.gguf");
		await expect(downloadVerified(url, dest, expected)).rejects.toThrow(/exceeded/);
		expect(existsSync(dest)).toBe(false);
	});

	it("keeps a partial file for resume after cancellation", async () => {
		const dest = join(dir, "model.gguf");
		const controller = new AbortController();
		await expect(
			downloadVerified(url, dest, expected, {
				signal: controller.signal,
				onProgress: () => controller.abort(),
			}),
		).rejects.toThrow();
		expect(existsSync(dest)).toBe(false);
		await downloadVerified(url, dest, expected);
		expect(await readFile(dest)).toEqual(payload);
	});
});

describe("file lock", () => {
	it("refuses a lock held by a live process and takes over a stale one", async () => {
		const lock = join(dir, "x.lock");
		await writeFile(lock, String(process.ppid));
		await expect(withFileLock(lock, async () => 1)).rejects.toThrow(/Another process/);
		await writeFile(lock, "999999999");
		expect(await withFileLock(lock, async () => 2)).toBe(2);
		expect(existsSync(lock)).toBe(false);
	});
});
