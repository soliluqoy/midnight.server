const assert = require("node:assert");
const { formatMoney } = require("./money.js");

assert.strictEqual(formatMoney(1050), "$10.50");
assert.strictEqual(formatMoney(123456789), "$1,234,567.89");
console.log("ok");
