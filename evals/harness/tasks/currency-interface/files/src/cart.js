const { formatPrice } = require("./format.js");

// One line per item plus the total. order = { currency, items: [{ name, price, quantity }] }
function cartSummary(order) {
	const lines = order.items.map((item) => `${item.name} x${item.quantity}: ${formatPrice(item.price * item.quantity)}`);
	const total = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
	return [...lines, `Total: ${formatPrice(total)}`].join("\n");
}

module.exports = { cartSummary };
