function parsePort(value) {
	const text = String(value).trim();
	if (!/^\d+$/.test(text)) throw new Error(`Invalid port: ${value}`);
	const port = Number(text);
	if (port < 1 || port > 65535) throw new Error(`Port out of range: ${value}`);
	return port;
}

module.exports = { parsePort };
