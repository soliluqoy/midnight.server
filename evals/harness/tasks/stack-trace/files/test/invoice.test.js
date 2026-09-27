const assert = require("node:assert");
const { createInvoice } = require("../src/services/invoice.js");
const { createOrder } = require("../src/services/orders.js");
const { customer } = require("../src/models/customer.js");
const order = createOrder(customer(1, "ann"), [{ item: { id: 1, name: "pen", price: 2 }, quantity: 3 }]);
assert.deepStrictEqual(createInvoice(order), { subtotal: 6, discount: 0, tax: 0, total: 6 });
