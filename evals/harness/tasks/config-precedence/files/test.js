const assert = require("node:assert");
const { loadConfig } = require("./config.js");
assert.strictEqual(loadConfig({ env: { port: 9000 }, cli: { port: 7000 } }).port, 7000);
console.log("ok");
