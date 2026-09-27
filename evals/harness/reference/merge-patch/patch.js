// Apply a JSON Merge Patch (RFC 7386) to a document and return the result.
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function applyPatch(target, patch) {
	if (!isObject(patch)) return patch;
	const result = isObject(target) ? { ...target } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete result[key];
		else result[key] = applyPatch(result[key], value);
	}
	return result;
}

module.exports = { applyPatch };
