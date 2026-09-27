// Turn a title into a URL slug.
function slugify(title) {
	return title
		.replace(/ß/g, "ss")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

module.exports = { slugify };
