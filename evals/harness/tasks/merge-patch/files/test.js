const assert = require("node:assert");
const { applyPatch } = require("./patch.js");
assert.deepStrictEqual(applyPatch({ a: "b" }, { a: "c" }), { a: "c" });
console.log("ok");
