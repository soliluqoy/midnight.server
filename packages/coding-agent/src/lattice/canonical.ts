import { createHash } from "node:crypto";

/**
 * Canonical encoding (spec section 37.3): UTF-8, object keys sorted, no insignificant
 * whitespace, NaN and infinities rejected. Structure is canonicalized; payload strings are
 * kept byte for byte (no Unicode normalization), because normalizing would change inputs.
 */
export function canonical(value: unknown): string {
	return encode(value);
}

function encode(value: unknown): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "boolean":
			return value ? "true" : "false";
		case "number":
			if (!Number.isFinite(value)) throw new Error("canonical encoding rejects NaN and infinities");
			return JSON.stringify(value);
		case "string":
			return JSON.stringify(value);
		case "object": {
			if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
			const record = value as Record<string, unknown>;
			const keys = Object.keys(record)
				.filter((key) => record[key] !== undefined)
				.sort();
			return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(",")}}`;
		}
		default:
			throw new Error(`canonical encoding cannot represent ${typeof value}`);
	}
}

export function sha256(text: string | Uint8Array): string {
	return createHash("sha256").update(text).digest("hex");
}

/** SHA-256 of the canonical encoding. */
export function digest(value: unknown): string {
	return sha256(canonical(value));
}
