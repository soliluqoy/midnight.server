// Turn a title into a URL slug.
function slugify(title) {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

module.exports = { slugify };
