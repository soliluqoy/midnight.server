const assert = require("node:assert");
const { roundHalf } = require("./rounding.js");

assert.strictEqual(roundHalf(1.2), 1);
assert.strictEqual(roundHalf(1.7), 2);
assert.strictEqual(roundHalf(2.5), 2);
console.log("ok");
