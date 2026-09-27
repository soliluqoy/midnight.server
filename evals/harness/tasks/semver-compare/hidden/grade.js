const assert = require("node:assert");
const { compareVersions } = require("./version.js");
const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.2.0", "1.10.0", "2.0.0"];
for (let i = 0; i < ordered.length; i++) {
	for (let j = 0; j < ordered.length; j++) {
		const got = Math.sign(compareVersions(ordered[i], ordered[j]));
		assert.strictEqual(got, Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
	}
}
assert.strictEqual(Math.sign(compareVersions("1.0.0+build.1", "1.0.0+build.2")), 0);
assert.strictEqual(Math.sign(compareVersions("1.0.0-alpha+001", "1.0.0-alpha")), 0);
console.log("pass");
