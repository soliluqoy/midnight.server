const assert = require("node:assert");
const { createUser } = require("./signup.js");

const user = createUser({ email: "ada@example.com", name: "Ada" });
assert.strictEqual(user.email, "ada@example.com");
assert.throws(() => createUser({ email: "not-an-email", name: "X" }));
console.log("ok");
