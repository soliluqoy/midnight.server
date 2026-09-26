// Turn a title into a URL slug: lowercase words joined by single hyphens.
function slugify(title) {
	return title
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.join("-");
}

module.exports = { slugify };
