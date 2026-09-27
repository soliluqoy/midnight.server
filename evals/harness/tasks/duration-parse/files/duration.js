// Parse a human duration string into milliseconds.
function parseDuration(text) {
	return Number(text) * 1000;
}

module.exports = { parseDuration };
