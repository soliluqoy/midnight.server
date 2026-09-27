// Build a URL query string (without the leading "?") from an object.
function buildQuery(params) {
	const parts = [];
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null) continue;
		for (const item of Array.isArray(value) ? value : [value]) {
			if (item === undefined || item === null) continue;
			parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
		}
	}
	return parts.join("&");
}

module.exports = { buildQuery };
