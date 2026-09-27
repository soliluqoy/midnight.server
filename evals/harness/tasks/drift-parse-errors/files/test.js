const assert = require("node:assert");
const { parseLines } = require("./parser.js");

assert.deepStrictEqual(parseLines("a=1\n# comment\n\nb=x=y\n"), { a: "1", b: "x=y" });
console.log("ok");
