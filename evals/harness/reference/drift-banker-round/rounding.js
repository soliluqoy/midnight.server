/** Round to the nearest integer; exact halves round to the even neighbor (banker's rounding). */
function roundHalf(value) {
	const floor = Math.floor(value);
	const diff = value - floor;
	if (diff > 0.5) return floor + 1;
	if (diff < 0.5) return floor;
	return floor % 2 === 0 ? floor : floor + 1;
}

module.exports = { roundHalf };
