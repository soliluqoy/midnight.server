const db = require("./lib/db.js");

/** The user with this id, or undefined. */
async function findUser(id) {
	const rows = await db.query("SELECT * FROM users WHERE id = $1", [id]);
	return rows[0];
}

/** The number of users whose status is "active". Database errors reach the caller. */
async function countActiveUsers() {
	const rows = await db.query("SELECT COUNT(*) AS n FROM users WHERE status = $1", ["active"]);
	return Number(rows[0].n);
}

module.exports = { countActiveUsers, findUser };
