import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadFilePreview } from "../src/file-preview.ts";

const LIMIT = 1024 * 1024;

test("preview rejects NUL bytes throughout the bounded buffer", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "midnight-preview-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "binary.dat");
	for (const offset of [0, 8191, 8192, LIMIT - 1]) {
		const bytes = Buffer.alloc(LIMIT, 65);
		bytes[offset] = 0;
		await writeFile(file, bytes);
		assert.deepEqual(await loadFilePreview(file), { kind: "message", text: "Binary file." }, `offset ${offset}`);
	}
});

test("preview rejects malformed UTF-8 instead of replacement decoding", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "midnight-preview-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "invalid.txt");
	for (const suffix of [[0xff], [0xc3], [0xc3, 0x28], [0xc0, 0xaf], [0xed, 0xa0, 0x80]]) {
		await writeFile(file, Buffer.concat([Buffer.alloc(8192, 65), Buffer.from(suffix)]));
		assert.deepEqual(await loadFilePreview(file), { kind: "message", text: "Not valid UTF-8 text." });
	}
});

test("preview preserves valid UTF-8 normalization and the 1 MiB size boundary", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "midnight-preview-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "文档.txt");
	await writeFile(file, "\u001b[31m文档 😀 café\u001b[0m\r\n\t\ufffd\n");
	assert.deepEqual(await loadFilePreview(file), { kind: "text", lines: ["文档 😀 café", "    \ufffd"] });
	await writeFile(file, "");
	assert.deepEqual(await loadFilePreview(file), { kind: "text", lines: [""] });
	await writeFile(file, Buffer.alloc(LIMIT, 65));
	const exact = await loadFilePreview(file);
	assert.equal(exact.kind, "text");
	if (exact.kind === "text") assert.deepEqual(exact.lines, ["A".repeat(LIMIT)]);
	await writeFile(file, Buffer.alloc(LIMIT + 1, 65));
	assert.deepEqual(await loadFilePreview(file), { kind: "message", text: "Too large to preview (limit: 1 MiB)." });
});
