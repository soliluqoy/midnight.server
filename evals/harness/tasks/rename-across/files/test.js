const assert = require("node:assert");
const { getUserName, profileHeader, greet } = require("./src/index.js");
assert.strictEqual(getUserName(1), "Ada Lovelace");
assert.strictEqual(profileHeader(2), "Profile of Alan Turing");
assert.strictEqual(greet(3), "Hello, Unknown!");
console.log("ok");
