const assert = require("node:assert");
const { createInvoice } = require("./src/services/invoice.js");
const { createOrder } = require("./src/services/orders.js");
const { customer } = require("./src/models/customer.js");
const { roundCents } = require("./src/utils/money.js");
for (const [input, expected] of [[1.005, 1.01], [2.675, 2.68], [1.345, 1.35], [0.125, 0.13], [10.235, 10.24], [1.004, 1], [2, 2], [-1.005, -1.01]]) {
	assert.strictEqual(roundCents(input), expected, `roundCents(${input})`);
}
const order = (price, quantity, vip = false) => createOrder(customer(1, "x", { vip }), [{ item: { id: 1, name: "i", price }, quantity }]);
assert.deepStrictEqual(createInvoice(order(6.7, 1, true)), { subtotal: 6.7, discount: 1.01, tax: 0, total: 5.69 });
assert.deepStrictEqual(createInvoice(order(20.1, 1), "CA"), { subtotal: 20.1, discount: 0, tax: 1.46, total: 21.56 });
assert.deepStrictEqual(createInvoice(order(2, 3)), { subtotal: 6, discount: 0, tax: 0, total: 6 });
console.log("pass");
