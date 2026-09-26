const { formatPrice } = require("./format.js");

function receiptLine(order, paid) {
	return `Paid ${formatPrice(paid, order.currency)} for order ${order.id}`;
}

module.exports = { receiptLine };
