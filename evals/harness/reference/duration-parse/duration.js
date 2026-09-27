// Parse a human duration string into milliseconds.
const UNITS = { h: 3600000, m: 60000, s: 1000, ms: 1 };

function parseDuration(text) {
	const input = String(text).replace(/\s+/g, "");
	if (!input) throw new Error("empty duration");
	let total = 0;
	let rest = input;
	while (rest) {
		const match = /^(\d+(?:\.\d+)?)(ms|h|m|s)/.exec(rest);
		if (!match) throw new Error(`invalid duration: ${text}`);
		total += Number(match[1]) * UNITS[match[2]];
		rest = rest.slice(match[0].length);
	}
	return total;
}

module.exports = { parseDuration };
