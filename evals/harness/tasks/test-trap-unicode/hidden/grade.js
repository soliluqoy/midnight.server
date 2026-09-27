const assert = require("node:assert");
const { slugify } = require("./slug.js");
assert.strictEqual(slugify("Hello World"), "hello-world");
assert.strictEqual(slugify("Ärger über Straße"), "arger-uber-strasse");
assert.strictEqual(slugify("Crème Brûlée"), "creme-brulee");
assert.strictEqual(slugify("  --Mixed__Case 42--  "), "mixed-case-42");
assert.strictEqual(slugify("Ωmega"), "mega");
console.log("pass");
