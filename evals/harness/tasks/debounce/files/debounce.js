// Delay calling fn until waitMs have passed since the last call.
function debounce(fn, waitMs) {
	let timer;
	return function (...args) {
		if (timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			fn();
		}, waitMs);
	};
}

module.exports = { debounce };
