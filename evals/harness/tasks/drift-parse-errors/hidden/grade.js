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

const parser = require("./parser.js");
const { parseLines } = parser;
const thrown = (text) => {
	try {
		parseLines(text);
	} catch (error) {
		return error;
	}
	throw new Error(`no error for ${JSON.stringify(text)}`);
};
(async () => {
	await req("throws-on-invalid", () => {
		thrown("a=1\noops\n");
		thrown("=5\n");
		thrown("  = x\n");
	});
	await req("line-number", () => {
		const error = thrown("a=1\n# note\n\nbroken line\nb=2\n");
		assert.strictEqual(error.line, 4);
		assert.match(error.message, /\b4\b/);
		assert.strictEqual(thrown("=5").line, 1);
	});
	await req("error-class", () => {
		assert.strictEqual(typeof parser.ParseError, "function", "ParseError is not exported");
		assert.ok(thrown("x\n") instanceof parser.ParseError);
		assert.ok(new parser.ParseError("m", 1) instanceof Error);
	});
	await req("still-ignores", () => {
		assert.deepStrictEqual(parseLines("# a\n\n   \nk=v\n#x=y\n"), { k: "v" });
	});
	await req("values-with-equals", () => {
		assert.deepStrictEqual(parseLines("url=https://x.test/?a=1&b=2\n"), { url: "https://x.test/?a=1&b=2" });
	});
	report();
})();
