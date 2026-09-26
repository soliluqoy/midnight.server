const assert = require("node:assert");
const { parsePort } = require("./port.js");
assert.strictEqual(parsePort("8080"), 8080);
console.log("ok");
