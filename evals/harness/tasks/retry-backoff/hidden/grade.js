const assert = require("node:assert");
const { retry } = require("./retry.js");
(async () => {
	let attempts = 0;
	const delays = [];
	const sleep = async (ms) => { delays.push(ms); };
	await assert.rejects(retry(async () => { attempts++; throw new Error(`fail ${attempts}`); }, { retries: 3, baseDelayMs: 100, sleep }), /fail 4/);
	assert.strictEqual(attempts, 4, "retries: 3 means 4 attempts");
	assert.strictEqual(delays.length, 3, "a wait between attempts, none after the last");
	assert.ok(delays[0] >= 100 && delays[1] > delays[0] && delays[2] > delays[1], `delays grow: ${delays}`);
	attempts = 0;
	const fatal = Object.assign(new Error("fatal"), { retryable: false });
	await assert.rejects(retry(async () => { attempts++; throw fatal; }, { retries: 5, sleep }), /fatal/);
	assert.strictEqual(attempts, 1, "non-retryable errors are not retried");
	attempts = 0;
	assert.strictEqual(await retry(async () => ++attempts, { retries: 0, sleep }), 1);
	console.log("pass");
})().catch((error) => { console.error(error); process.exit(1); });
