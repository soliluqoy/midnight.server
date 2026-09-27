const assert = require("node:assert");
const { getDisplayName, profileHeader, greet } = require("./src/index.js");
assert.strictEqual(getDisplayName(1), "Ada Lovelace");
assert.strictEqual(profileHeader(2), "Profile of Alan Turing");
assert.strictEqual(greet(3), "Hello, Unknown!");
console.log("ok");
