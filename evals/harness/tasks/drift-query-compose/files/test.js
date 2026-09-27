const assert = require("node:assert");
const { matches } = require("./filter.js");

const record = { a: 1, b: 2, c: "x" };
assert.strictEqual(matches(record, "a=1"), true);
assert.strictEqual(matches(record, "a!=2"), true);
assert.strictEqual(matches(record, "a=1 AND b=2"), true);
assert.strictEqual(matches(record, "a=2 OR c=x"), true);
assert.strictEqual(matches(record, "NOT a=2"), true);
assert.strictEqual(matches(record, "(a=1)"), true);
console.log("ok");
