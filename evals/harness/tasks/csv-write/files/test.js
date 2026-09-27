const assert = require("node:assert");
const { parseCsvLine } = require("./csv.js");
assert.deepStrictEqual(parseCsvLine('a,"b,c"'), ["a", "b,c"]);
console.log("ok");
