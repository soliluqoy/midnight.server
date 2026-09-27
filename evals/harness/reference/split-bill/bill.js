// Split a total (in cents) between n people. Returns an array of cent amounts that sum to the total.
function splitBill(totalCents, people) {
	if (!Number.isInteger(people) || people < 1) throw new Error("people must be a positive integer");
	const share = Math.floor(totalCents / people);
	const remainder = totalCents - share * people;
	return Array.from({ length: people }, (_, index) => share + (index < remainder ? 1 : 0));
}

module.exports = { splitBill };
