// Money helpers. Amounts are dollars as numbers.
function lineTotal(price, quantity) {
	return price * quantity;
}

function applyPercent(amount, percent) {
	return (amount * percent) / 100;
}

// Round to whole cents, half away from zero. toFixed rounds the binary value, so 1.005
// (stored as 1.00499...) became 1.00; correcting by a tiny epsilon rounds it to 1.01.
function roundCents(amount) {
	return Math.sign(amount) * Math.round(Math.abs(amount) * 100 + 1e-7) / 100;
}

module.exports = { lineTotal, applyPercent, roundCents };
