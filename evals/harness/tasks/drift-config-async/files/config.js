const { readFileSync } = require("node:fs");

/** Read and parse a JSON config file. */
function loadConfig(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

module.exports = { loadConfig };
