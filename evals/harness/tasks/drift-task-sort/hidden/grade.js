const results = [];
async function req(id, check) {
	try {
		const ok = await check();
		if (ok === false) throw new Error("returned false");
		results.push([id, true]);
	} catch (error) {
		results.push([id, false, String(error && error.message ? error.message : error).split("\n")[0].slice(0, 160)]);
	}
}
function report() {
	for (const [id, ok, message] of results) console.log(`REQ ${id} ${ok ? "PASS" : `FAIL ${message}`}`);
	process.exit(results.every((result) => result[1]) ? 0 : 1);
}
const assert = require("node:assert");

const { sortTasks } = require("./tasks.js");
const ids = (list) => list.map((task) => task.id);
(async () => {
	await req("priority", () => {
		assert.deepStrictEqual(ids(sortTasks([{ id: 1, priority: "low" }, { id: 2, priority: "high" }, { id: 3, priority: "medium" }])), [2, 3, 1]);
	});
	await req("due-tiebreak", () => {
		const list = [
			{ id: 1, priority: "high", due: "2026-12-01" },
			{ id: 2, priority: "high", due: "2026-10-01" },
			{ id: 3, priority: "low", due: "2026-01-01" },
			{ id: 4, priority: "high", due: "2026-11-15" },
		];
		assert.deepStrictEqual(ids(sortTasks(list)), [2, 4, 1, 3]);
	});
	await req("no-due-last", () => {
		const list = [
			{ id: 1, priority: "medium" },
			{ id: 2, priority: "medium", due: "2026-10-02" },
			{ id: 3, priority: "high" },
			{ id: 4, priority: "medium", due: "2026-09-30" },
		];
		assert.deepStrictEqual(ids(sortTasks(list)), [3, 4, 2, 1]);
	});
	await req("no-mutation", () => {
		const list = [{ id: 1, priority: "low" }, { id: 2, priority: "high" }];
		const result = sortTasks(list);
		assert.deepStrictEqual(ids(list), [1, 2], "the input array was reordered");
		assert.notStrictEqual(result, list, "returned the input array itself");
	});
	report();
})();
