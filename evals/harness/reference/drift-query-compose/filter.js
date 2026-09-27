/**
 * Does `record` match `query`? The query language: field=value, field!=value, A AND B,
 * A OR B, NOT A, and parentheses. NOT binds tightest, then AND, then OR.
 */
function matches(record, query) {
	const tokens = query.match(/\(|\)|[^\s()]+/g) ?? [];
	let position = 0;
	const peek = () => tokens[position];
	const take = () => tokens[position++];

	function parseOr() {
		let value = parseAnd();
		while (peek() === "OR") {
			take();
			const right = parseAnd();
			value = value || right;
		}
		return value;
	}
	function parseAnd() {
		let value = parseNot();
		while (peek() === "AND") {
			take();
			const right = parseNot();
			value = value && right;
		}
		return value;
	}
	function parseNot() {
		if (peek() === "NOT") {
			take();
			return !parseNot();
		}
		return parsePrimary();
	}
	function parsePrimary() {
		const token = take();
		if (token === "(") {
			const value = parseOr();
			if (take() !== ")") throw new SyntaxError(`Missing ")" in ${query}`);
			return value;
		}
		const match = /^([^!=]+)(!=|=)(.*)$/.exec(token ?? "");
		if (!match) throw new SyntaxError(`Bad condition "${token}" in ${query}`);
		const equal = String(record[match[1]]) === match[3];
		return match[2] === "=" ? equal : !equal;
	}

	const result = parseOr();
	if (position !== tokens.length) throw new SyntaxError(`Unexpected "${peek()}" in ${query}`);
	return result;
}

module.exports = { matches };
