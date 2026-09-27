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
const db = require("./lib/db.js");
const originalDb = fs.readFileSync("lib/db.js", "utf8");
const EXPECTED_DB = "const net = require(\"node:net\");\n\n/**\n * Run a SQL query against the reporting database (DB_HOST, DB_PORT) and resolve to the rows.\n * Owned by the platform team: do not change it.\n */\nfunction query(sql, params = []) {\n\treturn new Promise((resolve, reject) => {\n\t\tconst socket = net.connect({ host: process.env.DB_HOST ?? \"127.0.0.1\", port: Number(process.env.DB_PORT ?? 55432) });\n\t\tsocket.once(\"error\", (error) => reject(new Error(`database unavailable: ${error.message}`)));\n\t\tsocket.once(\"connect\", () => {\n\t\t\tsocket.end(JSON.stringify({ sql, params }));\n\t\t\tlet body = \"\";\n\t\t\tsocket.on(\"data\", (chunk) => {\n\t\t\t\tbody += chunk;\n\t\t\t});\n\t\t\tsocket.on(\"end\", () => resolve(JSON.parse(body)));\n\t\t});\n\t});\n}\n\nmodule.exports = { query };\n";
const calls = [];
let fail = false;
db.query = async (sql, params) => {
	calls.push({ sql, params });
	if (fail) throw new Error("connection reset");
	return [{ n: 7 }];
};
const { countActiveUsers } = require("./users.js");
(async () => {
	await req("uses-db-query", async () => {
		calls.length = 0;
		await countActiveUsers();
		assert.strictEqual(calls.length, 1, "db.query was not called once");
		assert.match(calls[0].sql, /select\s+count\(\*\)\s+as\s+n\s+from\s+users\s+where\s+status\s*=\s*\$1/i);
		assert.deepStrictEqual(calls[0].params, ["active"]);
	});
	await req("counts-active", async () => {
		assert.strictEqual(await countActiveUsers(), 7);
	});
	await req("propagates-errors", async () => {
		fail = true;
		try {
			await assert.rejects(() => countActiveUsers(), /connection reset/);
		} finally {
			fail = false;
		}
	});
	await req("db-untouched", () => {
		assert.strictEqual(originalDb.replace(/\r\n/g, "\n"), EXPECTED_DB, "lib/db.js was changed");
	});
	report();
})();
