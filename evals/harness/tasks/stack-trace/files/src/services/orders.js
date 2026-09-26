const { product } = require("../models/product.js");

let nextId = 1;

function createOrder(customer, lines) {
	return {
		id: nextId++,
		customer,
		lines: lines.map(({ item, quantity }) => ({ item: product(item.id, item.name, item.price), quantity })),
	};
}

module.exports = { createOrder };
