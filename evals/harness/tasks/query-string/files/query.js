// Build a URL query string (without the leading "?") from an object.
function buildQuery(params) {
	return Object.entries(params)
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
}

module.exports = { buildQuery };
