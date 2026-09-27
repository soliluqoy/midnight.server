// Report formatting. Dates are formatted in UTC.
function formatShipDate(date) {
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	return `Ships ${year}-${month}-${day}`;
}

function formatOrderDate(date) {
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	return `Ordered ${year}-${month}-${day}`;
}

function formatInvoiceDate(date) {
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	return `Invoiced ${year}-${month}-${day}`;
}

module.exports = { formatShipDate, formatOrderDate, formatInvoiceDate };
