const RATES = { CA: 7.25, NY: 4, TX: 6.25, OR: 0 };

function taxRate(state) {
	return RATES[state] ?? 0;
}

module.exports = { taxRate };
