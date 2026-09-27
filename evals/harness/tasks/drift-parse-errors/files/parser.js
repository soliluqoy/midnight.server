/** Parse `key=value` lines. Blank lines and # comments are ignored. */
function parseLines(text) {
	const result = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const index = line.indexOf("=");
		if (index <= 0) continue;
		result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
	}
	return result;
}

module.exports = { parseLines };
