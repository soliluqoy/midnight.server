const { formatPrice } = require("./format.js");

function orderEmail(order, total) {
	return `Your order ${order.id} of ${formatPrice(total)} has shipped.`;
}

module.exports = { orderEmail };
