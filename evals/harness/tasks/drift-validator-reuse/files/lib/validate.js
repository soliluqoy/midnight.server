/**
 * The email rule shared with the billing service: a local part of letters, digits and . _ % + -
 * with no leading, trailing or doubled dot, and a domain of at least two labels.
 */
function isEmail(value) {
	if (typeof value !== "string") return false;
	const match = /^([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/.exec(value);
	if (!match) return false;
	const local = match[1];
	return !local.startsWith(".") && !local.endsWith(".") && !local.includes("..");
}

module.exports = { isEmail };
