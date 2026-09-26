const assert = require("node:assert");
const { debounce } = require("./debounce.js");
let n = 0;
const d = debounce(() => n++, 10);
d(); d();
setTimeout(() => { assert.strictEqual(n, 1); console.log("ok"); }, 50);
