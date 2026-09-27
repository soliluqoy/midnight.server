const users = [];

/** Create and store a user. */
function createUser({ email, name }) {
	const user = { id: users.length + 1, email, name };
	users.push(user);
	return user;
}

module.exports = { createUser, users };
