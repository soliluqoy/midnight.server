const assert = require("node:assert");
const fs = require("node:fs");
const r = require("./report.js");
const pad = (n) => String(n).padStart(2, "0");
for (let t = Date.UTC(1999, 11, 25); t < Date.UTC(2031, 0, 1); t += 86400000 * 37 + 3600000 * 5) {
	const d = new Date(t);
	const s = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
	assert.strictEqual(r.formatShipDate(d), `Ships ${s}`);
	assert.strictEqual(r.formatOrderDate(d), `Ordered ${s}`);
	assert.strictEqual(r.formatInvoiceDate(d), `Invoiced ${s}`);
}
const source = fs.readFileSync("report.js", "utf8");
assert.ok((source.match(/getUTCFullYear/g) ?? []).length <= 1, "the date parts are computed in one place");
console.log("pass");
