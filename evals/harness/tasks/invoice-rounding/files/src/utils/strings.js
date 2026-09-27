function titleCase(text) {
	return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

function truncate(text, max) {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

module.exports = { titleCase, truncate };
