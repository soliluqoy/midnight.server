const assert = require("node:assert");
const { parseCsvLine, toCsvLine } = require("./csv.js");
assert.strictEqual(typeof toCsvLine, "function");
assert.strictEqual(toCsvLine(["a", "b", "c"]), "a,b,c", "plain fields are not quoted");
assert.strictEqual(toCsvLine(["x, y", "z"]), '"x, y",z');
assert.strictEqual(toCsvLine(['say "hi"']), '"say ' + '""hi""' + '"');
assert.strictEqual(toCsvLine(["", "a", ""]), ",a,");
assert.strictEqual(toCsvLine([1, true]), "1,true");
let seed = 3;
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const alphabet = ['a', 'b', ',', '"', ' ', 'z', '1'];
for (let trial = 0; trial < 500; trial++) {
	const fields = Array.from({ length: 1 + rand(4) }, () => Array.from({ length: rand(5) }, () => alphabet[rand(alphabet.length)]).join(""));
	assert.deepStrictEqual(parseCsvLine(toCsvLine(fields)), fields, JSON.stringify(fields));
}
console.log("pass");
