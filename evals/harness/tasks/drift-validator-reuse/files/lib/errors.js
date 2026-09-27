/** Input that breaks a rule. `field` names the offending field. */
class ValidationError extends Error {
	constructor(message, field) {
		super(message);
		this.name = "ValidationError";
		this.field = field;
	}
}

module.exports = { ValidationError };
