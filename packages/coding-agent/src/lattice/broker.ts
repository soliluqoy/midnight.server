import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonical } from "./canonical.ts";
import { type Host, LatticeError } from "./primitives.ts";

/**
 * The effect broker, read-only as R1 requires (spec section 43.1). A path string is not a
 * capability (section 43.2): the kernel issues a signed, short-lived record bound to one episode,
 * and every access resolves relative to its root, rejecting absolute paths, parent traversal and
 * symlink or reparse-point escapes. Inventory is "best-effort": metadata observed at a time,
 * labeled as such (section 43.3); exact content goes through `contentHashHost`, which checks each
 * file against that inventory. Renames are applied by `effects.ts`; reports go only to the
 * kernel's own content-addressed artifact store.
 */
export type Verb = "list" | "read" | "rename";

export interface Capability {
	capability_id: string;
	kind: "filesystem";
	root: string;
	verbs: Verb[];
	expires_at: number;
	episode_id: string;
	signature: string;
}

function sign(key: string, body: Omit<Capability, "signature">): string {
	return createHmac("sha256", key).update(canonical(body)).digest("base64");
}

export function issueCapability(
	key: string,
	args: { root: string; verbs: Verb[]; episodeId: string; ttlMs?: number },
): Capability {
	const root = realpathSync(resolve(args.root));
	if (!statSync(root).isDirectory()) throw new Error(`${args.root} is not a directory`);
	const body: Omit<Capability, "signature"> = {
		capability_id: `cap_${createHmac("sha256", key).update(`${root}\0${args.episodeId}`).digest("hex").slice(0, 24)}`,
		kind: "filesystem",
		root,
		verbs: [...args.verbs].sort(),
		expires_at: Date.now() + (args.ttlMs ?? 5 * 60_000),
		episode_id: args.episodeId,
	};
	return { ...body, signature: sign(key, body) };
}

/** The guest cannot manufacture or widen a capability: the signature binds root, verbs, expiry and episode. */
export function verifyCapability(key: string, capability: Capability, verb: Verb, episodeId: string): void {
	const { signature, ...body } = capability;
	const expected = Buffer.from(sign(key, body));
	const actual = Buffer.from(signature);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		throw new LatticeError("effect", "capability signature invalid");
	}
	if (capability.episode_id !== episodeId) throw new LatticeError("effect", "capability bound to another episode");
	if (Date.now() > capability.expires_at) throw new LatticeError("effect", "capability expired");
	if (!capability.verbs.includes(verb)) throw new LatticeError("effect", `capability does not grant ${verb}`);
}

/** Resolve a relative reference inside the root, or throw. */
export function resolveInside(root: string, ref: string): string {
	if (ref.length === 0 || isAbsolute(ref) || /^[A-Za-z]:/.test(ref) || ref.startsWith("\\\\")) {
		throw new LatticeError("effect", "absolute paths are not allowed");
	}
	const parts = ref.split(/[\\/]+/);
	if (parts.includes("..")) throw new LatticeError("effect", "parent traversal is not allowed");
	const target = resolve(root, ...parts);
	const rel = relative(root, target);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new LatticeError("effect", "path escapes the capability root");
	return target;
}

export interface InventoryEntry {
	path: string;
	size: number;
	hidden: boolean;
	kind: "file" | "dir";
}

/** What the broker observed about a file: enough to notice it was replaced or changed later. */
export interface FileIdentity {
	size: number;
	mtime_ns: string;
	ino: string;
}

/** Identity of the object at `path` without following links, or undefined when nothing is there. */
export function observeIdentity(path: string): (FileIdentity & { kind: "file" | "dir" | "other" }) | undefined {
	try {
		const stats = lstatSync(path, { bigint: true });
		return {
			size: Number(stats.size),
			mtime_ns: stats.mtimeNs.toString(),
			ino: stats.ino.toString(),
			kind: stats.isSymbolicLink() ? "other" : stats.isFile() ? "file" : stats.isDirectory() ? "dir" : "other",
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export interface InventorySnapshot {
	mode: "best-effort inventory";
	observed_at: string;
	root: string;
	entries: InventoryEntry[];
	/** Identity of every regular file entry, for effect plans that must detect later changes. */
	identities: { [path: string]: FileIdentity };
	/** Paths not included, with the reason (symlink, permission denied, vanished). */
	skipped: { path: string; reason: string }[];
}

/**
 * Walk the capability root without following symlinks. Hidden means any path segment starts
 * with a dot. More than `maxEntries` entries is an error, not a truncation: the report contract
 * requires every entry to be accounted for.
 */
export function scanDirectory(
	key: string,
	capability: Capability,
	episodeId: string,
	maxEntries: number,
): InventorySnapshot {
	verifyCapability(key, capability, "list", episodeId);
	const entries: InventoryEntry[] = [];
	const identities: { [path: string]: FileIdentity } = {};
	const skipped: { path: string; reason: string }[] = [];
	const pending: string[] = [""];
	while (pending.length > 0) {
		const dir = pending.pop()!;
		let names: string[];
		try {
			names = readdirSync(dir ? join(capability.root, ...dir.split("/")) : capability.root).sort();
		} catch (error) {
			skipped.push({ path: dir || ".", reason: (error as NodeJS.ErrnoException).code ?? "unreadable" });
			continue;
		}
		for (const name of names) {
			const path = dir ? `${dir}/${name}` : name;
			let stats: BigIntStats;
			try {
				stats = lstatSync(join(capability.root, ...path.split("/")), { bigint: true });
			} catch (error) {
				skipped.push({ path, reason: (error as NodeJS.ErrnoException).code ?? "vanished" });
				continue;
			}
			if (stats.isSymbolicLink()) {
				skipped.push({ path, reason: "symlink (not followed)" });
				continue;
			}
			const hidden = path.split("/").some((segment) => segment.startsWith("."));
			if (stats.isDirectory()) {
				entries.push({ path, size: 0, hidden, kind: "dir" });
				pending.push(path);
			} else if (stats.isFile()) {
				entries.push({ path, size: Number(stats.size), hidden, kind: "file" });
				identities[path] = {
					size: Number(stats.size),
					mtime_ns: stats.mtimeNs.toString(),
					ino: stats.ino.toString(),
				};
			} else skipped.push({ path, reason: "not a regular file" });
			if (entries.length > maxEntries) {
				throw new LatticeError("bound", `directory has more than ${maxEntries} entries; use a larger task budget`);
			}
		}
	}
	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return {
		mode: "best-effort inventory",
		observed_at: new Date().toISOString(),
		root: capability.root,
		entries,
		identities,
		skipped,
	};
}

export const HASH_CHUNK_BYTES = 65_536;

export interface ContentHashHost extends Host {
	/** What was read (spec section 43.4 step 7), for the goal's evidence. */
	readonly observed: { files: number; bytes: number; cacheHits: number };
}

/**
 * A `contentHash` host bound to one capability and the inventory it was issued with (spec section
 * 43.4). For each file: resolve inside the root without following links, open it, check that the
 * opened object still has the identity the inventory recorded, stream SHA-256 over bounded chunks,
 * and check the identity again. A file that changed while it was read is retried once; a file that
 * changed since the inventory, or keeps changing, fails with "unstable input" rather than giving a
 * digest of bytes the inventory never described. This is a verified bounded read, not a
 * filesystem snapshot: a writer that restores size and modification time can go unnoticed.
 *
 * Digests are kept for the host's lifetime (one episode), keyed by path and re-validated against
 * the file's identity on every use, so a program that hashes a file twice reads it once.
 */
export function contentHashHost(
	key: string,
	capability: Capability,
	episodeId: string,
	identities: { readonly [path: string]: FileIdentity },
): ContentHashHost {
	const digests = new Map<string, string>();
	const observed = { files: 0, bytes: 0, cacheHits: 0 };
	const sameIdentity = (stats: BigIntStats, expected: FileIdentity) =>
		stats.isFile() &&
		Number(stats.size) === expected.size &&
		stats.mtimeNs.toString() === expected.mtime_ns &&
		stats.ino.toString() === expected.ino;
	const hashOnce = (real: string, expected: FileIdentity): string | undefined => {
		const fd = openSync(real, "r");
		try {
			if (!sameIdentity(fstatSync(fd, { bigint: true }), expected)) {
				throw new LatticeError("host", "unstable input: file changed since the inventory");
			}
			const hash = createHash("sha256");
			const buffer = Buffer.alloc(Math.min(HASH_CHUNK_BYTES, Math.max(expected.size, 1)));
			let total = 0;
			for (;;) {
				const read = readSync(fd, buffer, 0, buffer.length, total);
				if (read === 0) break;
				hash.update(buffer.subarray(0, read));
				total += read;
				if (total > expected.size) return undefined;
			}
			observed.bytes += total;
			return total === expected.size && sameIdentity(fstatSync(fd, { bigint: true }), expected)
				? hash.digest("hex")
				: undefined;
		} finally {
			closeSync(fd);
		}
	};
	return {
		observed,
		contentHash(ref: string, size: number): string {
			verifyCapability(key, capability, "read", episodeId);
			const expected = identities[ref];
			if (!expected) throw new LatticeError("host", "file is not in the inventory");
			// `content_hash` declares that equal digests imply equal sizes; this check is what makes it true.
			if (expected.size !== size) throw new LatticeError("host", "unstable input: size differs from the inventory");
			const target = resolveInside(capability.root, ref);
			const current = observeIdentity(target);
			if (!current || current.kind !== "file")
				throw new LatticeError("host", "unstable input: file is gone or replaced");
			if (current.size !== expected.size || current.mtime_ns !== expected.mtime_ns || current.ino !== expected.ino) {
				throw new LatticeError("host", "unstable input: file changed since the inventory");
			}
			const cached = digests.get(ref);
			if (cached !== undefined) {
				observed.cacheHits++;
				return cached;
			}
			const real = realpathSync(target);
			if (relative(capability.root, real).split(sep).join("/") !== ref.split(/[\\/]+/).join("/")) {
				throw new LatticeError("effect", "path resolves through a link");
			}
			for (let attempt = 0; attempt < 2; attempt++) {
				const digest = hashOnce(real, expected);
				if (digest !== undefined) {
					observed.files++;
					digests.set(ref, digest);
					return digest;
				}
			}
			throw new LatticeError("host", "unstable input: file changed while it was read");
		},
	};
}

/**
 * A `readText` host bound to one capability. The opened file's identity is checked against the
 * resolved path after opening, so a swap between check and open is detected rather than trusted.
 */
export function readTextHost(key: string, capability: Capability, episodeId: string) {
	return {
		readText(ref: string, maxBytes: number): string {
			verifyCapability(key, capability, "read", episodeId);
			const target = resolveInside(capability.root, ref);
			let real: string;
			try {
				real = realpathSync(target);
			} catch {
				throw new LatticeError("host", "file not found");
			}
			const rel = relative(capability.root, real);
			if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
				throw new LatticeError("effect", "symlink escapes the capability root");
			}
			const fd = openSync(real, "r");
			try {
				const opened = fstatSync(fd);
				const named = statSync(real);
				if (!opened.isFile() || opened.ino !== named.ino || opened.dev !== named.dev) {
					throw new LatticeError("host", "unstable input: file changed while opening");
				}
				const buffer = Buffer.alloc(Math.min(maxBytes, opened.size));
				const read = readSync(fd, buffer, 0, buffer.length, 0);
				return buffer.subarray(0, read).toString("utf8");
			} finally {
				closeSync(fd);
			}
		},
	};
}
