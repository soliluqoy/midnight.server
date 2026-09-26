const { getDisplayName } = require("./users.js");

function profileHeader(id) {
	return `Profile of ${getDisplayName(id)}`;
}

module.exports = { profileHeader };
