const assert = require("node:assert");
const { render } = require("./template.js");
assert.strictEqual(render("Hi {{name}}", { name: "Ann" }), "Hi Ann");
assert.strictEqual(render("{{{html}}}", { html: "<b>x</b>" }), "<b>x</b>");
console.log("ok");
