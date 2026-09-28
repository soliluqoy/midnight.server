/**
 * Crash injection (spec section 46.2). When `LATTICE_FAULT` names a point, the process exits
 * immediately there: no commit, no cleanup, no further writes. Tests run the kernel in a child
 * process with this set, then reopen the store and check that the state is old, new, or
 * explicitly unresolved, never silently in between.
 */
export const FAULT_EXIT_CODE = 97;

export type FaultPoint =
	| "artifact-before-row"
	| "promote-before-commit"
	| "promote-after-commit"
	| "snapshot-before-manifest"
	| "effect-after-prepare"
	| "effect-after-rename";

export function faultPoint(name: FaultPoint): void {
	if (process.env.LATTICE_FAULT === name) process.exit(FAULT_EXIT_CODE);
}
