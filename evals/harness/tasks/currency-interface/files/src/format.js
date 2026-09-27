// Format an amount in dollars for display.
function formatPrice(amount) {
	return `$${amount.toFixed(2)}`;
}

module.exports = { formatPrice };
