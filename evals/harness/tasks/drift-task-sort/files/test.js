const assert = require("node:assert");
const { sortTasks } = require("./tasks.js");

const sorted = sortTasks([
	{ id: 1, priority: "low" },
	{ id: 2, priority: "high" },
	{ id: 3, priority: "medium" },
]);
assert.deepStrictEqual(
	sorted.map((task) => task.id),
	[2, 3, 1],
);
console.log("ok");
