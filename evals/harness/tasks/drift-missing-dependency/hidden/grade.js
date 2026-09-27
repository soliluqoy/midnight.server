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
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

const fs = require("node:fs");
const source = stripComments(fs.readFileSync("report.js", "utf8"));
const { formatDue } = require("./report.js");
(async () => {
	await req("uses-dayjs", () => {
		assert.match(source, /require\(\s*["']dayjs["']\s*\)|from\s+["']dayjs["']/, "report.js does not use dayjs");
		globalThis.__dayjsCalls = 0;
		formatDue("2026-10-01");
		assert.ok(globalThis.__dayjsCalls > 0, "formatDue does not call dayjs");
	});
	await req("declares-dependency", () => {
		const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
		assert.ok(manifest.dependencies && manifest.dependencies.dayjs, "dayjs is not in package.json dependencies");
	});
	await req("formats", () => {
		assert.strictEqual(formatDue("2026-10-01"), "01 Oct 2026");
		assert.strictEqual(formatDue("2027-02-28"), "28 Feb 2027");
	});
	await req("invalid-input", () => {
		assert.strictEqual(formatDue("2026-02-30"), "invalid date");
		assert.strictEqual(formatDue("tomorrow"), "invalid date");
	});
	report();
})();
