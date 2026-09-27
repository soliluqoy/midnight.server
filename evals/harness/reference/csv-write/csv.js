// CSV helpers (RFC 4180, one line at a time).

// Parse one line of CSV into an array of field strings.
function parseCsvLine(line) {
	const fields = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (quoted) {
			if (char === '"' && line[i + 1] === '"') {
				field += '"';
				i++;
			} else if (char === '"') quoted = false;
			else field += char;
		} else if (char === '"') quoted = true;
		else if (char === ",") {
			fields.push(field);
			field = "";
		} else field += char;
	}
	fields.push(field);
	return fields;
}

// Format fields as one line of CSV, quoting only fields that need it.
function toCsvLine(fields) {
	return fields
		.map((value) => {
			const text = String(value);
			return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
		})
		.join(",");
}

module.exports = { parseCsvLine, toCsvLine };
