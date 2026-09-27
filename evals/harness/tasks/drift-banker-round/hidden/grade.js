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

const { roundHalf } = require("./rounding.js");
(async () => {
	await req("halves-to-even", () => {
		for (const [input, expected] of [[0.5, 0], [1.5, 2], [2.5, 2], [3.5, 4], [10.5, 10], [11.5, 12]]) assert.strictEqual(roundHalf(input), expected, `${input}`);
	});
	await req("negative-halves", () => {
		for (const [input, expected] of [[-0.5, 0], [-1.5, -2], [-2.5, -2], [-3.5, -4]]) assert.ok(Object.is(roundHalf(input) + 0, expected + 0), `${input} -> ${roundHalf(input)}`);
	});
	await req("non-halves", () => {
		for (const [input, expected] of [[1.2, 1], [1.7, 2], [-1.2, -1], [-1.7, -2], [7, 7], [2.4999, 2], [2.5001, 3]]) assert.strictEqual(roundHalf(input), expected, `${input}`);
	});
	report();
})();
