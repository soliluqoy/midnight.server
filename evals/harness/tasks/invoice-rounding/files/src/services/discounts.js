// Discount percentage for an order, 0-100.
function discountFor(customer, subtotal) {
	if (customer.vip) return 15;
	if (subtotal >= 100) return 10;
	return 0;
}

module.exports = { discountFor };
