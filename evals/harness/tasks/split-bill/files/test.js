const assert = require("node:assert");
const { splitBill } = require("./bill.js");
assert.deepStrictEqual(splitBill(900, 3), [300, 300, 300]);
console.log("ok");
