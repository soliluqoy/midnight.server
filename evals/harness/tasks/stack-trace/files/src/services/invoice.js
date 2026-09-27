const { lineTotal, applyPercent, roundCents } = require("../utils/money.js");
const { discountFor } = require("./discounts.js");
const { taxRate } = require("./tax.js");

// Totals for an order: subtotal, discount, tax and total, in dollars.
function createInvoice(order, state = "OR") {
	const subtotal = roundCents(order.lines.reduce((sum, line) => sum + lineTotal(line.item.price, line.quantity), 0));
	const discount = roundCents(applyPercent(subtotal, discountFor(order.customer, subtotal)));
	const taxable = roundCents(subtotal - discount);
	const tax = roundCents(applyPercent(taxable, taxRate(state)));
	return { subtotal, discount, tax, total: roundCents(taxable + tax) };
}

module.exports = { createInvoice };
