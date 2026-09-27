// Least-recently-used cache with a fixed capacity.
class LRUCache {
	constructor(capacity) {
		this.capacity = capacity;
		this.map = new Map();
	}

	get(key) {
		return this.map.get(key);
	}

	set(key, value) {
		if (this.map.size >= this.capacity) {
			const oldest = this.map.keys().next().value;
			this.map.delete(oldest);
		}
		this.map.set(key, value);
	}

	get size() {
		return this.map.size;
	}
}

module.exports = { LRUCache };
