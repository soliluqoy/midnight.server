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

const { formatMoney } = require("./money.js");
(async () => {
	await req("currencies", () => {
		assert.strictEqual(formatMoney(1050, "EUR"), "€10.50");
		assert.strictEqual(formatMoney(1050, "GBP"), "£10.50");
		assert.strictEqual(formatMoney(1050, "USD"), "$10.50");
		assert.strictEqual(formatMoney(1050), "$10.50");
	});
	await req("two-decimals", () => {
		assert.strictEqual(formatMoney(100), "$1.00");
		assert.strictEqual(formatMoney(7), "$0.07");
	});
	await req("thousands", () => {
		assert.strictEqual(formatMoney(123456789), "$1,234,567.89");
		assert.strictEqual(formatMoney(100000, "EUR"), "€1,000.00");
		assert.strictEqual(formatMoney(99999), "$999.99");
	});
	await req("negative-parens", () => {
		assert.strictEqual(formatMoney(-1050), "($10.50)");
		assert.strictEqual(formatMoney(-123456789, "GBP"), "(£1,234,567.89)");
	});
	await req("zero-dash", () => {
		assert.strictEqual(formatMoney(0), "-");
		assert.strictEqual(formatMoney(0, "EUR"), "-");
	});
	await req("unknown-throws", () => {
		assert.throws(() => formatMoney(100, "JPY"), RangeError);
		assert.throws(() => formatMoney(100, "usd"), RangeError);
	});
	report();
})();
