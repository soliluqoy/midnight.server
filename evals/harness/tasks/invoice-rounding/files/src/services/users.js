// User-facing views of customers.
function teamLabel(customer) {
	return customer.team ? customer.team.name : "No team";
}

function displayProfile(customer) {
	return { name: customer.name, vip: customer.vip, team: teamLabel(customer) };
}

module.exports = { displayProfile, teamLabel };
