/** Does `record` match `query`? Supported: field=value. */
function matches(record, query) {
	const [field, value] = query.split("=");
	return String(record[field.trim()]) === value.trim();
}

module.exports = { matches };
