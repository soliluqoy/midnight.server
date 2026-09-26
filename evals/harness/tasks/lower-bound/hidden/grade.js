const assert = require("node:assert");
const { lowerBound } = require("./search.js");
const reference = (array, value) => { const i = array.findIndex((x) => x >= value); return i === -1 ? array.length : i; };
let seed = 7;
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
for (let trial = 0; trial < 2000; trial++) {
	const array = Array.from({ length: rand(12) }, () => rand(10)).sort((a, b) => a - b);
	const value = rand(12) - 1;
	assert.strictEqual(lowerBound(array, value), reference(array, value), `${JSON.stringify(array)} ${value}`);
}
console.log("pass");
