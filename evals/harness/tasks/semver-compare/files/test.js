const assert = require("node:assert");
const { compareVersions } = require("./version.js");
assert.ok(compareVersions("1.2.3", "1.10.0") < 0);
assert.ok(compareVersions("1.0.0-beta", "1.0.0") < 0);
console.log("ok");
