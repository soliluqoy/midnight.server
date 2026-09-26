// Split a total (in cents) between n people. Returns an array of cent amounts.
function splitBill(totalCents, people) {
	const share = Math.floor(totalCents / people);
	return Array.from({ length: people }, () => share);
}

module.exports = { splitBill };
