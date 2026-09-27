const assert = require("node:assert");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { sumValues } = require("./stats.js");

const file = join(mkdtempSync(join(tmpdir(), "stats-")), "values.txt");
writeFileSync(file, "1\n2\n\n3\n");
sumValues(file).then((total) => {
	assert.strictEqual(total, 6);
	console.log("ok");
});
