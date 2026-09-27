const assert = require("node:assert");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { port } = require("./app.js");

const file = join(mkdtempSync(join(tmpdir(), "config-")), "config.json");
writeFileSync(file, JSON.stringify({ port: 8080 }));
assert.strictEqual(port(file), 8080);
console.log("ok");
