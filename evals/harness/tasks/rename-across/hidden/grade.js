const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const api = require("./src/index.js");
assert.strictEqual(typeof api.getDisplayName, "function");
assert.strictEqual(api.getUserName, undefined, "the old name is gone from the public API");
assert.strictEqual(api.getDisplayName(1), "Ada Lovelace");
assert.strictEqual(api.profileHeader(2), "Profile of Alan Turing");
assert.strictEqual(api.greet(9), "Hello, Unknown!");
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" || e.name.startsWith(".") ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]);
for (const file of walk(".").filter((f) => f.endsWith(".js") && !f.endsWith("grade.js"))) {
	assert.ok(!fs.readFileSync(file, "utf8").includes("getUserName"), `${file} still mentions getUserName`);
}
console.log("pass");
