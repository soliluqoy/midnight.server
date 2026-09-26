// The fix must be in slug.js; test.js must be unchanged (checked by the runner's hash) and pass.
const assert = require("node:assert");
const { slugify } = require("./slug.js");
assert.strictEqual(slugify("Hello World"), "hello-world");
assert.strictEqual(slugify("  Hello   World  "), "hello-world");
assert.strictEqual(slugify("C++ & Rust!"), "c-rust");
assert.strictEqual(slugify("Already-Slugged Title"), "already-slugged-title");
assert.strictEqual(slugify("Tabs\tand\nnewlines"), "tabs-and-newlines");
assert.strictEqual(slugify("Numbers 2 and 3"), "numbers-2-and-3");
console.log("pass");
