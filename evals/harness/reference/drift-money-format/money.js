const SYMBOLS = { USD: "$", EUR: "€", GBP: "£" };

/**
 * Format an amount in cents for invoices: currency symbol, two decimals, comma thousands,
 * negatives in parentheses, zero as "-". Unknown currencies throw a RangeError.
 */
function formatMoney(cents, currency = "USD") {
	if (!Object.hasOwn(SYMBOLS, currency)) throw new RangeError(`Unknown currency: ${currency}`);
	if (cents === 0) return "-";
	const absolute = Math.abs(cents);
	const whole = Math.floor(absolute / 100)
		.toString()
		.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	const text = `${SYMBOLS[currency]}${whole}.${String(absolute % 100).padStart(2, "0")}`;
	return cents < 0 ? `(${text})` : text;
}

module.exports = { formatMoney };
