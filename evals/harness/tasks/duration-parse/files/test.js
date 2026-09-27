const assert = require("node:assert");
const { parseDuration } = require("./duration.js");
assert.strictEqual(parseDuration("45s"), 45000);
console.log("ok");
