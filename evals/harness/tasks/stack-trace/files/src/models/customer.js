function customer(id, name, { vip = false, team } = {}) {
	return { id, name, vip, team };
}

module.exports = { customer };
