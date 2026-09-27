// Least-recently-used cache with a fixed capacity.
class LRUCache {
	constructor(capacity) {
		this.capacity = capacity;
		this.map = new Map();
	}

	get(key) {
		if (!this.map.has(key)) return undefined;
		const value = this.map.get(key);
		this.map.delete(key);
		this.map.set(key, value);
		return value;
	}

	set(key, value) {
		if (this.map.has(key)) this.map.delete(key);
		else if (this.map.size >= this.capacity) {
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
