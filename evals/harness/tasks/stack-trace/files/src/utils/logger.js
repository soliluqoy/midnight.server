const levels = ["debug", "info", "warn", "error"];
let minimum = "info";

function setLevel(level) {
	if (!levels.includes(level)) throw new Error(`unknown level ${level}`);
	minimum = level;
}

function log(level, message) {
	if (levels.indexOf(level) >= levels.indexOf(minimum)) return `[${level}] ${message}`;
	return undefined;
}

module.exports = { setLevel, log };
