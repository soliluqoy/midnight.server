const { createReadStream } = require("node:fs");
const { createInterface } = require("node:readline");

/** Sum the numeric lines of a file, reading it as a stream. Blank lines are skipped. */
async function sumValues(path) {
	const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
	let total = 0;
	for await (const line of lines) {
		if (line.trim() === "") continue;
		total += Number(line);
	}
	return total;
}

module.exports = { sumValues };
