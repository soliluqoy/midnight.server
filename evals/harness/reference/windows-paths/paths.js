// Normalize a relative path to forward slashes, resolving "." and ".." segments.
// Accepts both separators. Throws if the path escapes above its root.
function normalizeRelative(path) {
	const out = [];
	for (const part of path.split(/[\\/]+/)) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (out.length === 0) throw new Error(`path escapes its root: ${path}`);
			out.pop();
		} else out.push(part);
	}
	return out.join("/");
}

module.exports = { normalizeRelative };
