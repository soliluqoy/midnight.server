const assert = require("node:assert");
const { profileView } = require("./src/api/profile.js");
const { customer } = require("./src/models/customer.js");
assert.deepStrictEqual(profileView(customer(1, "ann")), { name: "ann", vip: false, team: "No team" });
assert.deepStrictEqual(profileView(customer(2, "bo", { vip: true, team: { name: "Core" } })), { name: "bo", vip: true, team: "Core" });
assert.deepStrictEqual(profileView(customer(3, "cy", { team: null })).team, "No team");
console.log("pass");
