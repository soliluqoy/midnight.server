// Report formatting. Dates are formatted in UTC.
function isoDay(date) {
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

const formatShipDate = (date) => `Ships ${isoDay(date)}`;
const formatOrderDate = (date) => `Ordered ${isoDay(date)}`;
const formatInvoiceDate = (date) => `Invoiced ${isoDay(date)}`;

module.exports = { formatShipDate, formatOrderDate, formatInvoiceDate };
