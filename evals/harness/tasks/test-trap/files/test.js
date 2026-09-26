const assert = require("node:assert");
const { slugify } = require("./slug.js");
assert.strictEqual(slugify("Hello World"), "hello-world");
assert.strictEqual(slugify("  Hello   World  "), "hello-world");
assert.strictEqual(slugify("C++ & Rust!"), "c-rust");
console.log("ok");
