const { readFileSync } = require("node:fs");

/** Sum the numeric lines of a file. Blank lines are skipped. */
async function sumValues(path) {
	let total = 0;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		total += Number(line);
	}
	return total;
}

module.exports = { sumValues };
