// Apply a JSON Merge Patch to a document and return the result.
function applyPatch(target, patch) {
	return { ...target, ...patch };
}

module.exports = { applyPatch };
