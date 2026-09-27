const assert = require("node:assert");
const { formatDue } = require("./report.js");

assert.strictEqual(formatDue("2026-10-01"), "01 Oct 2026");
console.log("ok");
