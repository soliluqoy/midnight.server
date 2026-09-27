// Normalize a relative path to forward slashes, resolving "." and ".." segments.
function normalizeRelative(path) {
	const out = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return out.join("/");
}

module.exports = { normalizeRelative };
