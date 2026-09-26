const assert = require("node:assert");
const { retry } = require("./retry.js");
(async () => {
	let n = 0;
	const value = await retry(async () => { if (++n < 2) throw new Error("x"); return 42; }, { sleep: async () => {} });
	assert.strictEqual(value, 42);
	console.log("ok");
})();
