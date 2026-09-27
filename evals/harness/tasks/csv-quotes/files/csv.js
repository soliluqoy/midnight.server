// Parse one line of CSV into an array of field strings.
function parseCsvLine(line) {
	return line.split(",");
}

module.exports = { parseCsvLine };
