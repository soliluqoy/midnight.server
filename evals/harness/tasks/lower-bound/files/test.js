const assert = require("node:assert");
const { lowerBound } = require("./search.js");
assert.strictEqual(lowerBound([1, 3, 5, 7], 5), 2);
console.log("ok");
