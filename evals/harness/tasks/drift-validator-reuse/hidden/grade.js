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

const fs = require("node:fs");
const source = fs.readFileSync("signup.js", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const { createUser, users } = require("./signup.js");
const { ValidationError } = require("./lib/errors.js");
const rejects = (email) =>
	assert.throws(() => createUser({ email, name: "x" }), (error) => error instanceof ValidationError && error.field === "email", String(email));
(async () => {
	await req("uses-project-rule", () => {
		assert.match(source, /require\(\s*["']\.\/lib\/validate(?:\.js)?["']\s*\)/, "signup.js does not use lib/validate.js");
		assert.match(source, /isEmail\s*\(/, "signup.js does not call isEmail");
	});
	await req("rejects-invalid", () => {
		for (const email of ["a..b@example.com", ".a@example.com", "a.@example.com", "user@localhost", "not-an-email", 42, undefined]) rejects(email);
	});
	await req("accepts-valid", () => {
		for (const email of ["a+tag@mail.example.co", "first.last@sub.example.org", "x_y%z@example.io"]) {
			assert.strictEqual(createUser({ email, name: "ok" }).email, email);
		}
	});
	await req("error-type", () => {
		try {
			createUser({ email: "bad", name: "x" });
		} catch (error) {
			assert.ok(error instanceof ValidationError, "not the ValidationError from lib/errors.js");
			assert.strictEqual(error.field, "email");
			return;
		}
		throw new Error("no error thrown");
	});
	await req("not-stored", () => {
		const before = users.length;
		try {
			createUser({ email: "still bad", name: "x" });
		} catch {}
		assert.strictEqual(users.length, before, "an invalid user was stored");
	});
	report();
})();
