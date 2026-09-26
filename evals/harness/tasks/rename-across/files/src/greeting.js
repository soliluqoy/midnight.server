const users = require("./users.js");

function greet(id) {
	return `Hello, ${users.getUserName(id)}!`;
}

module.exports = { greet };
