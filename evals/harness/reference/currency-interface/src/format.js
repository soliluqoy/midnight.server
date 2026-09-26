const CURRENCIES = { USD: ["$", 2], EUR: ["€", 2], GBP: ["£", 2], JPY: ["¥", 0] };

// Format an amount for display in a currency (default USD).
function formatPrice(amount, currency = "USD") {
	const [symbol, decimals] = CURRENCIES[currency] ?? CURRENCIES.USD;
	return `${symbol}${amount.toFixed(decimals)}`;
}

module.exports = { formatPrice };
