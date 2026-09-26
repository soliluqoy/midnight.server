const assert = require("node:assert");
const { normalizeRelative } = require("./paths.js");
assert.strictEqual(normalizeRelative("a/./b/../c"), "a/c");
console.log("ok");
