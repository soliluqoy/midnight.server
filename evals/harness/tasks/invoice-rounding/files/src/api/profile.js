const { displayProfile } = require("../services/users.js");

function profileView(customer) {
	return displayProfile(customer);
}

module.exports = { profileView };
