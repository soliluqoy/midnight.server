const { titleCase } = require("../utils/strings.js");

function welcomeEmail(customer) {
	return { subject: `Welcome, ${titleCase(customer.name)}`, body: "Thanks for joining." };
}

module.exports = { welcomeEmail };
