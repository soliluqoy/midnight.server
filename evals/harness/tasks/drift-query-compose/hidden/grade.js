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

const { matches } = require("./filter.js");
const record = { a: 1, b: 2, c: "x", d: "y" };
const check = (query, expected) => assert.strictEqual(matches(record, query), expected, query);
(async () => {
	await req("single-features", () => {
		check("a=2", false);
		check("a!=1", false);
		check("a=1 AND b=3", false);
		check("a=2 OR b=3", false);
		check("NOT a=1", false);
	});
	await req("precedence", () => {
		check("a=2 OR b=2 AND c=x", true);
		check("a=1 OR b=3 AND c=z", true);
		check("a=2 AND b=2 OR c=z", false);
		check("NOT a=2 AND b=2", true);
	});
	await req("not-group", () => {
		check("NOT (a=1 AND b=3)", true);
		check("NOT (a=1 OR b=3)", false);
	});
	await req("nested", () => {
		check("(a=1 AND (b=3 OR c=x)) AND NOT (d=z)", true);
		check("((a=2 OR b=2) AND (c=x AND d!=y))", false);
	});
	await req("double-not", () => {
		check("NOT NOT a=1", true);
		check("NOT NOT (a=1 AND b=3)", false);
	});
	report();
})();
