const assert = require("node:assert");
const { applyPatch } = require("./patch.js");
const cases = [
	[{ a: "b" }, { a: "c" }, { a: "c" }],
	[{ a: "b" }, { b: "c" }, { a: "b", b: "c" }],
	[{ a: "b" }, { a: null }, {}],
	[{ a: "b", b: "c" }, { a: null }, { b: "c" }],
	[{ a: ["b"] }, { a: "c" }, { a: "c" }],
	[{ a: "c" }, { a: ["b"] }, { a: ["b"] }],
	[{ a: { b: "c" } }, { a: { b: "d", c: null } }, { a: { b: "d" } }],
	[{ a: [{ b: "c" }] }, { a: [1] }, { a: [1] }],
	[["a", "b"], ["c", "d"], ["c", "d"]],
	[{ a: "b" }, ["c"], ["c"]],
	[{ a: "foo" }, null, null],
	[{ a: "foo" }, "bar", "bar"],
	[{ e: null }, { a: 1 }, { e: null, a: 1 }],
	[[1, 2], { a: "b", c: null }, { a: "b" }],
	[{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
];
for (const [target, patch, expected] of cases) {
	const before = JSON.stringify(target);
	assert.deepStrictEqual(applyPatch(target, patch), expected, `${before} + ${JSON.stringify(patch)}`);
	assert.strictEqual(JSON.stringify(target), before, "must not mutate the target");
}
console.log("pass");
