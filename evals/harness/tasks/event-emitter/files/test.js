const assert = require("node:assert");
const { EventEmitter } = require("./emitter.js");
const e = new EventEmitter();
let n = 0;
e.on("x", () => n++);
e.emit("x");
assert.strictEqual(n, 1);
console.log("ok");
