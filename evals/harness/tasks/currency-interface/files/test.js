const assert = require("node:assert");
const { cartSummary } = require("./src/cart.js");
const order = { id: 7, currency: "USD", items: [{ name: "pen", price: 1.5, quantity: 2 }] };
assert.strictEqual(cartSummary(order), "pen x2: $3.00\nTotal: $3.00");
console.log("ok");
