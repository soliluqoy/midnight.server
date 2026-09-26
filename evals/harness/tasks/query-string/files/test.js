const assert = require("node:assert");
const { buildQuery } = require("./query.js");
assert.strictEqual(buildQuery({ a: 1, b: "x" }), "a=1&b=x");
console.log("ok");
