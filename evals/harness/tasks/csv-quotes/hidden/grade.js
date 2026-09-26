// RFC 4180 fields on one line: quoted fields, commas inside quotes, doubled quotes, empty fields.
const assert = require("node:assert");
const { parseCsvLine } = require("./csv.js");
assert.deepStrictEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);
assert.deepStrictEqual(parseCsvLine('"x, y",z'), ["x, y", "z"]);
assert.deepStrictEqual(parseCsvLine('"she said ""hi""",2'), ['she said "hi"', "2"]);
assert.deepStrictEqual(parseCsvLine("a,,c"), ["a", "", "c"]);
assert.deepStrictEqual(parseCsvLine(",a,"), ["", "a", ""]);
assert.deepStrictEqual(parseCsvLine('""'), [""]);
assert.deepStrictEqual(parseCsvLine('1,"two",3'), ["1", "two", "3"]);
console.log("pass");
