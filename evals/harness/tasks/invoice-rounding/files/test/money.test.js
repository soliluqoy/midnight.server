const assert = require("node:assert");
const { lineTotal } = require("../src/utils/money.js");
assert.strictEqual(lineTotal(2.5, 4), 10);
