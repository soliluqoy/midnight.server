const { ValidationError } = require("./lib/errors.js");
const { isEmail } = require("./lib/validate.js");

const users = [];

/** Create and store a user. Throws ValidationError (field "email") for an invalid email. */
function createUser({ email, name }) {
	if (!isEmail(email)) throw new ValidationError(`Invalid email: ${email}`, "email");
	const user = { id: users.length + 1, email, name };
	users.push(user);
	return user;
}

module.exports = { createUser, users };
