const assert = require("node:assert");
const { LRUCache } = require("./lru.js");
const cache = new LRUCache(2);
cache.set("a", 1);
cache.set("b", 2);
assert.strictEqual(cache.get("a"), 1);
console.log("ok");
