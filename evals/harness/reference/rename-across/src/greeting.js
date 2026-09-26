const users = require("./users.js");

function greet(id) {
	return `Hello, ${users.getDisplayName(id)}!`;
}

module.exports = { greet };
