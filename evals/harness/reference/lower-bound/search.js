// Index of the first element >= value in a sorted array (array.length if none).
function lowerBound(array, value) {
	let lo = 0;
	let hi = array.length;
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (array[mid] < value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

module.exports = { lowerBound };
