const DEFAULTS = { port: 8080, verbose: false, name: "app", retries: 3 };

// Merge configuration sources: defaults < file < env < cli. Undefined means not given.
function loadConfig({ file = {}, env = {}, cli = {} } = {}) {
	const result = { ...DEFAULTS };
	for (const source of [file, env, cli]) {
		for (const [key, value] of Object.entries(source)) {
			if (value !== undefined) result[key] = value;
		}
	}
	return result;
}

module.exports = { loadConfig, DEFAULTS };
