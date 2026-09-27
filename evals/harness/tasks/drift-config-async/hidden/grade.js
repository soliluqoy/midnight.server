const results = [];
async function req(id, check) {
	try {
		const ok = await check();
		if (ok === false) throw new Error("returned false");
		results.push([id, true]);
	} catch (error) {
		results.push([id, false, String(error && error.message ? error.message : error).split("\n")[0].slice(0, 160)]);
	}
}
function report() {
	for (const [id, ok, message] of results) console.log(`REQ ${id} ${ok ? "PASS" : `FAIL ${message}`}`);
	process.exit(results.every((result) => result[1]) ? 0 : 1);
}
const assert = require("node:assert");

const fs = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const config = require("./config.js");
const { port } = require("./app.js");
const dir = fs.mkdtempSync(join(tmpdir(), "config-grade-"));
const good = join(dir, "good.json");
const bad = join(dir, "bad.json");
const missing = join(dir, "missing.json");
fs.writeFileSync(good, JSON.stringify({ port: 9000, name: "x" }));
fs.writeFileSync(bad, "{ not json");
(async () => {
	await req("sync-kept", () => {
		const value = config.loadConfig(good);
		assert.ok(!(value && typeof value.then === "function"), "loadConfig returns a Promise");
		assert.deepStrictEqual(value, { port: 9000, name: "x" });
		assert.strictEqual(port(good), 9000);
	});
	await req("async-added", async () => {
		assert.strictEqual(typeof config.loadConfigAsync, "function", "loadConfigAsync is not exported");
		const pending = config.loadConfigAsync(good);
		assert.ok(pending && typeof pending.then === "function", "loadConfigAsync does not return a Promise");
		assert.deepStrictEqual(await pending, { port: 9000, name: "x" });
	});
	await req("error-class", () => {
		assert.strictEqual(typeof config.ConfigError, "function", "ConfigError is not exported");
		assert.ok(config.ConfigError.prototype instanceof Error, "ConfigError does not extend Error");
	});
	await req("sync-errors", () => {
		for (const file of [missing, bad]) {
			assert.throws(
				() => config.loadConfig(file),
				(error) => error instanceof config.ConfigError && error.message.includes(file),
				file,
			);
		}
	});
	await req("async-errors", async () => {
		for (const file of [missing, bad]) {
			await assert.rejects(
				() => config.loadConfigAsync(file),
				(error) => error instanceof config.ConfigError && error.message.includes(file),
				file,
			);
		}
	});
	report();
})();
