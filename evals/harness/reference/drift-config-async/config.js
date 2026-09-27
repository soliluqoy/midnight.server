const { readFileSync, promises } = require("node:fs");

/** A config file is missing or is not valid JSON. The message names the file. */
class ConfigError extends Error {
	constructor(path, cause) {
		super(`Cannot load config ${path}: ${cause.message}`);
		this.name = "ConfigError";
		this.path = path;
		this.cause = cause;
	}
}

function parse(path, text) {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new ConfigError(path, error);
	}
}

/** Read and parse a JSON config file. */
function loadConfig(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new ConfigError(path, error);
	}
	return parse(path, text);
}

/** Read and parse a JSON config file without blocking. */
async function loadConfigAsync(path) {
	let text;
	try {
		text = await promises.readFile(path, "utf8");
	} catch (error) {
		throw new ConfigError(path, error);
	}
	return parse(path, text);
}

module.exports = { ConfigError, loadConfig, loadConfigAsync };
