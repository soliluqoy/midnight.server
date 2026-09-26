// Date helpers used by reports and invoices.
function isoDate(date) {
	return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
	const next = new Date(date.getTime());
	next.setUTCDate(next.getUTCDate() + days);
	return next;
}

function dueDate(issued, termsDays = 30) {
	return addDays(issued, termsDays);
}

module.exports = { isoDate, addDays, dueDate };
