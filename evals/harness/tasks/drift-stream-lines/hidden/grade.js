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
const source = fs.readFileSync("stats.js", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const { sumValues } = require("./stats.js");
const dir = fs.mkdtempSync(join(tmpdir(), "stats-grade-"));
const file = (name, text) => {
	const target = join(dir, name);
	fs.writeFileSync(target, text);
	return target;
};
(async () => {
	await req("streams", () => {
		assert.match(source, /createReadStream/, "does not use fs.createReadStream");
		assert.match(source, /readline|createInterface/, "does not read lines with node:readline");
		assert.doesNotMatch(source, /readFileSync|readFile\s*\(|promises\.readFile|\.readFile\b/, "still reads the whole file");
	});
	await req("sum", async () => {
		assert.strictEqual(await sumValues(file("a.txt", "1\n2\n3")), 6);
		assert.strictEqual(await sumValues(file("b.txt", "1.5\n-0.5\n")), 1);
	});
	await req("blank-and-crlf", async () => {
		assert.strictEqual(await sumValues(file("c.txt", "4\r\n5\r\n\r\n")), 9);
		assert.strictEqual(await sumValues(file("d.txt", "\n\n7\n  \n")), 7);
	});
	await req("async", () => {
		const result = sumValues(file("e.txt", "1\n"));
		assert.ok(result && typeof result.then === "function", "does not return a Promise");
		return result.then(() => true);
	});
	report();
})();
