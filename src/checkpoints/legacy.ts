import { randomUUID } from "node:crypto";
import {
	type Checkpoint,
	exclusion,
	git,
	MAX_CAPTURE_BYTES,
	MAX_FILE_BYTES,
	MAX_PATHS,
	safePath,
	storeImportedCheckpoint,
} from "./core.ts";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export interface LegacyCheckpoint {
	ref: string;
	sessionId: string;
	snapshot: Checkpoint;
}
const text = async (root: string, args: string[]) => (await git(root, args)).toString("utf8").trim();
export async function readLegacyCheckpoint(root: string, ref: string): Promise<LegacyCheckpoint> {
	if (!/^refs\/pi-checkpoints\/[\w-]+$/.test(ref)) throw new Error("Invalid legacy reference.");
	const raw = (await git(root, ["cat-file", "commit", ref])).toString("utf8");
	if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("Legacy metadata exceeds 1 MiB.");
	const field = (name: string) => new RegExp(`^${name} (.+)$`, "m").exec(raw)?.[1]?.trim();
	const sessionId = field("sessionId");
	const indexTree = field("index-tree");
	const worktreeTree = field("worktree-tree");
	const headValue = field("head");
	const branchValue = field("branch");
	const timestamp = Date.parse(field("created") ?? "");
	if (
		!sessionId ||
		sessionId.length >= 512 ||
		!indexTree ||
		!SHA.test(indexTree) ||
		!worktreeTree ||
		!SHA.test(worktreeTree) ||
		!headValue ||
		!SHA.test(headValue) ||
		!branchValue ||
		!Number.isFinite(timestamp)
	)
		throw new Error("Unsupported or invalid legacy checkpoint metadata.");
	const head = /^0+$/.test(headValue) ? null : headValue;
	const branch =
		branchValue === "HEAD"
			? "detached"
			: branchValue.startsWith("refs/heads/")
				? branchValue
				: `refs/heads/${branchValue}`;
	if (branch !== "detached") await git(root, ["check-ref-format", branch]);
	if ((await text(root, ["rev-parse", `${ref}^{tree}`])) !== worktreeTree)
		throw new Error("Legacy worktree object mismatch.");
	const skipped = (name: string) => {
		const raw = field(name);
		const data: unknown = raw ? JSON.parse(raw) : [];
		if (!Array.isArray(data) || data.length > MAX_PATHS || !data.every((p) => typeof p === "string" && safePath(p)))
			throw new Error("Invalid legacy exclusions.");
		return data as string[];
	};
	const largeFiles = new Set(skipped("largeFiles"));
	const largeDirs = skipped("largeDirs");
	const modes = new Map<string, string>();
	const sizes = new Map<string, number>();
	for (const sha of new Set([indexTree, worktreeTree, ...(head ? [head] : [])])) {
		for (const record of (await git(root, ["ls-tree", "-rlz", "--full-tree", sha]))
			.toString("utf8")
			.split("\0")
			.filter(Boolean)) {
			const tab = record.indexOf("\t");
			const [mode, type, oid, size] = record.slice(0, tab).trim().split(/\s+/);
			const path = record.slice(tab + 1);
			if (tab < 0 || !safePath(path) || !SHA.test(oid) || !["blob", "commit"].includes(type))
				throw new Error("Invalid legacy tree entry.");
			if (mode === "120000" || mode === "160000" || !modes.has(path)) modes.set(path, mode);
			sizes.set(path, Math.max(sizes.get(path) ?? 0, type === "blob" ? Number(size) : 0));
		}
	}
	if (modes.size > MAX_PATHS) throw new Error("Legacy checkpoint has too many paths.");
	const covered: string[] = [];
	const excluded: Checkpoint["excluded"] = [];
	let bytes = 0;
	for (const [path, mode] of modes) {
		let reason = exclusion(path);
		if (mode === "120000" || mode === "160000") reason = "legacy symlink or submodule";
		if (largeFiles.has(path) || largeDirs.some((dir) => path === dir || path.startsWith(`${dir}/`)))
			reason = "legacy coverage exclusion";
		const size = sizes.get(path) ?? 0;
		if (!Number.isFinite(size) || size > MAX_FILE_BYTES || bytes + size > MAX_CAPTURE_BYTES)
			reason = "legacy size/read bound";
		if (reason) excluded.push({ path, reason });
		else {
			covered.push(path);
			bytes += size;
		}
	}
	for (const path of [...largeFiles, ...largeDirs])
		if (!excluded.some((entry) => entry.path === path)) excluded.push({ path, reason: "legacy coverage exclusion" });
	if (excluded.length > MAX_PATHS) throw new Error("Legacy exclusions exceed their bound.");
	const baseline = head ? head : await text(root, ["mktree"]);
	const pending = new Set<string>();
	for (const sha of new Set([indexTree, worktreeTree]))
		for (const path of (await git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", baseline, sha]))
			.toString("utf8")
			.split("\0")
			.filter(Boolean))
			pending.add(path);
	return {
		ref,
		sessionId,
		snapshot: {
			version: 1,
			id: randomUUID(),
			sessionId,
			entryId: null,
			contextRevision: null,
			trigger: "manual",
			timestamp,
			branch,
			head,
			indexTree,
			worktreeTree,
			covered,
			excluded,
			scope: covered.filter((p) => pending.has(p)),
		},
	};
}
export async function legacyCheckpoints(
	root: string,
	sessionId: string,
): Promise<{ available: LegacyCheckpoint[]; unavailable: number }> {
	const refs = (await text(root, ["for-each-ref", "--format=%(refname)", "refs/pi-checkpoints/"]))
		.split("\n")
		.filter(Boolean);
	if (refs.length > 1000) throw new Error("Too many legacy references; inspect manually.");
	const available: LegacyCheckpoint[] = [];
	let unavailable = 0;
	for (const ref of refs) {
		try {
			const cp = await readLegacyCheckpoint(root, ref);
			if (cp.sessionId === sessionId) available.push(cp);
		} catch {
			unavailable++;
		}
	}
	return { available, unavailable };
}
export async function importLegacyCheckpoint(root: string, ref: string, sessionId: string) {
	const legacy = await readLegacyCheckpoint(root, ref);
	if (legacy.sessionId !== sessionId) throw new Error("Legacy checkpoint belongs to another session.");
	return storeImportedCheckpoint(root, legacy.snapshot);
}
