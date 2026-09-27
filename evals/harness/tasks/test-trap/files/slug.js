// Turn a title into a URL slug: lowercase words joined by single hyphens.
function slugify(title) {
	return title.toLowerCase().split(" ").join("-");
}

module.exports = { slugify };
