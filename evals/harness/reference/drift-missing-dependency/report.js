const dayjs = require("dayjs");

/** Format a task's due date for the weekly report: "DD MMM YYYY", or "invalid date". */
function formatDue(isoString) {
	const date = dayjs(isoString);
	return date.isValid() ? date.format("DD MMM YYYY") : "invalid date";
}

module.exports = { formatDue };
