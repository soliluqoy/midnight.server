/** Ported upstream array invariants remain checked at runtime rather than asserted away. */
export function defined<T>(value: T | undefined | null): T {
	if (value === undefined || value === null) throw new Error("Missing context state required by an invariant.");
	return value;
}
