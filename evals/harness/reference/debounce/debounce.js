// Delay calling fn until waitMs have passed since the last call, with the latest arguments.
function debounce(fn, waitMs) {
	let timer;
	const debounced = function (...args) {
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			fn.apply(this, args);
		}, waitMs);
	};
	debounced.cancel = () => {
		clearTimeout(timer);
		timer = undefined;
	};
	return debounced;
}

module.exports = { debounce };
