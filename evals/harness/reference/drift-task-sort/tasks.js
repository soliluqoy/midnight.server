const ORDER = { high: 0, medium: 1, low: 2 };

/**
 * A new array sorted by priority (high, medium, low), then by due date ascending, with tasks
 * that have no due date last within their priority. The input is not changed.
 */
function sortTasks(tasks) {
	return [...tasks].sort((a, b) => {
		const byPriority = ORDER[a.priority] - ORDER[b.priority];
		if (byPriority !== 0) return byPriority;
		if (!a.due || !b.due) return (a.due ? 0 : 1) - (b.due ? 0 : 1);
		return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
	});
}

module.exports = { sortTasks };
