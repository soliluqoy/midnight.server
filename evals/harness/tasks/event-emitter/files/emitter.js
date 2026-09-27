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
		const index = list.indexOf(listener);
		if (index >= 0) list.splice(index, 1);
		return this;
	}

	once(event, listener) {
		const wrapper = (...args) => {
			listener(...args);
			this.off(event, listener);
		};
		return this.on(event, wrapper);
	}

	emit(event, ...args) {
		const list = this.listeners[event];
		if (!list) return false;
		for (let i = 0; i < list.length; i++) list[i](...args);
		return true;
	}
}

module.exports = { EventEmitter };
