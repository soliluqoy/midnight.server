const db = require("./lib/db.js");

/** The user with this id, or undefined. */
async function findUser(id) {
	const rows = await db.query("SELECT * FROM users WHERE id = $1", [id]);
	return rows[0];
}

module.exports = { findUser };
