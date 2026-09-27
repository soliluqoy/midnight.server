// A product in the catalog. Prices are in dollars.
function product(id, name, price) {
	if (price < 0) throw new Error("price must not be negative");
	return { id, name, price };
}

module.exports = { product };
