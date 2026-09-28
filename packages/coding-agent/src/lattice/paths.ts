import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where Lattice keeps its state. Shared by the kernel and by the harness, whose policy lives in
 * the same store.
 */
export function defaultDataDir(): string {
	return process.env.LATTICE_DATA || join(homedir(), ".midnight.server", "lattice");
}
