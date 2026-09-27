// Parse one line of CSV into an array of field strings (RFC 4180 quoting).
function parseCsvLine(line) {
	const fields = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quoted) {
			if (ch === '"' && line[i + 1] === '"') {
				field += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else field += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") {
			fields.push(field);
			field = "";
		} else field += ch;
	}
	fields.push(field);
	return fields;
}

module.exports = { parseCsvLine };
