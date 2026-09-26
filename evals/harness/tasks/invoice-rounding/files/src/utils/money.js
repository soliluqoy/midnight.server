// Money helpers. Amounts are dollars as numbers.
function lineTotal(price, quantity) {
	return price * quantity;
}

function applyPercent(amount, percent) {
	return (amount * percent) / 100;
}

// Round to whole cents.
function roundCents(amount) {
	return Number(amount.toFixed(2));
}

module.exports = { lineTotal, applyPercent, roundCents };
