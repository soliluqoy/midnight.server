import { homedir } from "node:os";
import { join } from "node:path";

/** Where Lattice keeps its state. */
export function defaultDataDir(): string {
	return process.env.LATTICE_DATA || join(homedir(), ".midnight.server", "lattice");
}
