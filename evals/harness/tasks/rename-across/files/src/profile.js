const { getUserName } = require("./users.js");

function profileHeader(id) {
	return `Profile of ${getUserName(id)}`;
}

module.exports = { profileHeader };
