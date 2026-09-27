/** An invalid line. `line` is its 1-based number. */
class ParseError extends Error {
	constructor(message, line) {
		super(message);
		this.name = "ParseError";
		this.line = line;
	}
}

/**
 * Parse `key=value` lines. Blank lines and # comments are ignored; a line with no "=" or an
 * empty key throws a ParseError naming its line number.
 */
function parseLines(text) {
	const result = {};
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].trim();
		if (!line || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		const key = separator < 0 ? "" : line.slice(0, separator).trim();
		if (!key) throw new ParseError(`Line ${index + 1}: expected key=value, got "${line}"`, index + 1);
		result[key] = line.slice(separator + 1).trim();
	}
	return result;
}

module.exports = { ParseError, parseLines };
