class EventEmitter {
	constructor() {
		this.listeners = {};
	}

	on(event, listener) {
		(this.listeners[event] ??= []).push(listener);
		return this;
	}

	off(event, listener) {
		const list = this.listeners[event];
		if (!list) return this;
		const index = list.findIndex((entry) => entry === listener || entry.original === listener);
		if (index >= 0) list.splice(index, 1);
		return this;
	}

	once(event, listener) {
		const wrapper = (...args) => {
			this.off(event, wrapper);
			listener(...args);
		};
		wrapper.original = listener;
		return this.on(event, wrapper);
	}

	emit(event, ...args) {
		const list = this.listeners[event];
		if (!list || list.length === 0) return false;
		for (const listener of [...list]) listener(...args);
		return true;
	}
}

module.exports = { EventEmitter };
