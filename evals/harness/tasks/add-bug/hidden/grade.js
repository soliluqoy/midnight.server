const assert = require("node:assert");
const { add } = require("./math.js");
for (const [a, b] of [[2, 3], [-1, 1], [0, 0], [1.5, 2.25], [-4, -6]]) assert.strictEqual(add(a, b), a + b);
console.log("pass");
