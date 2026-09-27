const ORDER = { high: 0, medium: 1, low: 2 };

/** Sort tasks by priority. */
function sortTasks(tasks) {
	return tasks.sort((a, b) => ORDER[a.priority] - ORDER[b.priority]);
}

module.exports = { sortTasks };
