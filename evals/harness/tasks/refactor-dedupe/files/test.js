const assert = require("node:assert");
const r = require("./report.js");
assert.strictEqual(r.formatShipDate(new Date(Date.UTC(2024, 0, 5))), "Ships 2024-01-05");
console.log("ok");
