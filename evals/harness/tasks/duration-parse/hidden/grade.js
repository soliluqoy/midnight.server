const assert = require("node:assert");
const { parseDuration } = require("./duration.js");
const cases = { "45s": 45000, "1h30m": 5400000, "250ms": 250, "2m": 120000, "1h": 3600000, "1m30s": 90000, "0s": 0, "1h 5m": 3900000, "10m5s250ms": 605250 };
for (const [input, ms] of Object.entries(cases)) assert.strictEqual(parseDuration(input), ms, input);
const rejects = (input) => { try { const out = parseDuration(input); return out === undefined || out === null || Number.isNaN(out); } catch { return true; } };
for (const bad of ["", "abc", "5x", "h", "1.5.3s", "-"]) assert.ok(rejects(bad), `should reject ${JSON.stringify(bad)}`);
console.log("pass");
