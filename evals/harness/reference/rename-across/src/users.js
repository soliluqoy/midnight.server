const users = new Map([[1, { first: "Ada", last: "Lovelace" }], [2, { first: "Alan", last: "Turing" }]]);

// Full display name for a user id, or "Unknown".
function getDisplayName(id) {
	const user = users.get(id);
	return user ? `${user.first} ${user.last}` : "Unknown";
}

module.exports = { getDisplayName };
