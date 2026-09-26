const assert = require("node:assert");
const { parseCsvLine } = require("./csv.js");
assert.deepStrictEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);
assert.deepStrictEqual(parseCsvLine('"x, y",z'), ["x, y", "z"]);
console.log("ok");
