const assert = require("node:assert");
const { countActiveUsers } = require("./users.js");

countActiveUsers().then((count) => {
	assert.strictEqual(typeof count, "number");
	console.log("ok");
});
