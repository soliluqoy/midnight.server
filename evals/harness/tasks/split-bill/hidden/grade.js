const assert = require("node:assert");
const { splitBill } = require("./bill.js");
for (const [total, n] of [[1000, 3], [1, 2], [0, 4], [9999, 7], [100, 1], [5, 10]]) {
	const parts = splitBill(total, n);
	assert.strictEqual(parts.length, n);
	assert.strictEqual(parts.reduce((a, b) => a + b, 0), total, `${total}/${n} must sum exactly`);
	assert.ok(Math.max(...parts) - Math.min(...parts) <= 1, "shares differ by at most one cent");
	assert.ok(parts.every(Number.isInteger));
}
const rejects = (fn) => { try { fn(); return false; } catch { return true; } };
assert.ok(rejects(() => splitBill(100, 0)), "zero people is an error");
console.log("pass");
