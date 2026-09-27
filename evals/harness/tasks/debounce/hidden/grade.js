const assert = require("node:assert");
const { debounce } = require("./debounce.js");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
	const calls = [];
	const d = debounce(function (...args) { calls.push([this && this.id, ...args]); }, 30);
	const obj = { id: "o", d };
	obj.d(1); await wait(10); obj.d(2); await wait(10); obj.d(3);
	await wait(15);
	assert.deepStrictEqual(calls, [], "waits until quiet");
	await wait(40);
	assert.deepStrictEqual(calls, [["o", 3]], "calls once with the latest arguments and this");
	const e = debounce(() => calls.push("e"), 20);
	e(); e.cancel(); await wait(40);
	assert.ok(!calls.includes("e"), "cancel prevents the pending call");
	e(); await wait(40);
	assert.ok(calls.includes("e"), "usable after cancel");
	console.log("pass");
})().catch((error) => { console.error(error); process.exit(1); });
