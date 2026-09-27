const { loadConfig } = require("./config.js");

/** The port to listen on, from the config file, default 3000. */
function port(path) {
	return loadConfig(path).port ?? 3000;
}

module.exports = { port };
