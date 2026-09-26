const assert = require("node:assert");
const { slugify } = require("./slug.js");
assert.strictEqual(slugify("Hello World"), "hello-world");
assert.strictEqual(slugify("Ärger über Straße"), "arger-uber-strasse");
console.log("ok");
