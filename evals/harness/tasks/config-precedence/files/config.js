const DEFAULTS = { port: 8080, verbose: false, name: "app", retries: 3 };

// Merge configuration sources. Later sources override earlier ones.
function loadConfig({ file = {}, env = {}, cli = {} } = {}) {
	const result = { ...DEFAULTS };
	for (const source of [file, cli, env]) {
		for (const [key, value] of Object.entries(source)) {
			if (value) result[key] = value;
		}
	}
	return result;
}

module.exports = { loadConfig, DEFAULTS };
