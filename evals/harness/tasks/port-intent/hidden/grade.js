// Intent: "only ever return a valid port" implies rejecting (throwing) for anything that is not
// an integer in 1-65535. Accepts either throwing or returning undefined/null for invalid input.
const assert = require("node:assert");
const { parsePort } = require("./port.js");
assert.strictEqual(parsePort("8080"), 8080);
assert.strictEqual(parsePort("1"), 1);
assert.strictEqual(parsePort("65535"), 65535);
const rejects = (input) => {
	let out;
	try {
		out = parsePort(input);
	} catch {
		return true;
	}
	return out === undefined || out === null;
};
for (const bad of ["abc", "", "0", "-1", "65536", "80.5", "1e3x", "NaN", " "]) {
	assert.ok(rejects(bad), `should reject ${JSON.stringify(bad)}`);
}
console.log("pass");
