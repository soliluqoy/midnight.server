import { lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Capability, type FileIdentity, observeIdentity, resolveInside, verifyCapability } from "./broker.ts";
import { canonical, digest } from "./canonical.ts";
import { LatticeError } from "./primitives.ts";
import type { EffectPlanRow, LatticeStore } from "./store.ts";

/**
 * Recoverable local effects (spec sections 13.6 and 43.5-43.8). A skill never touches the
 * filesystem: it returns intents. The kernel turns them into a plan that records what the broker
 * observed about every source, and nothing happens until the plan is applied, which is the
 * user's approval of that exact plan hash.
 *
 * Applying one intent:
 *   1. durably journal it as `prepared`;
 *   2. recheck the source identity and that the destination is still absent;
 *   3. create missing parent directories (recorded, for compensation), then rename;
 *   4. verify the result (the same file at the destination, nothing at the source);
 *   5. journal `committed` with its compensation record.
 * A SQLite transaction and a rename are not one atomic step; the journal bridges them, and
 * `reconcileEffects` resolves entries a crash left `prepared` (section 43.7). A batch is not
 * atomic either: the first failure stops the plan and earlier moves stay, each undoable.
 * Undo is conditional compensation: it never overwrites a newer change by the user.
 */
export interface MoveIntent {
	kind: "rename";
	source: string;
	destination: string;
	/** The source as observed when the plan was made. */
	expected: FileIdentity;
	destination_must_be_absent: true;
	idempotency_key: string;
}

export const PLAN_TTL_MS = 60 * 60 * 1000;

export interface EffectHooks {
	/** Fault injection for tests: runs after an intent is journaled `prepared`. */
	afterPrepared?(index: number): void;
	/** Fault injection for tests: runs after the rename, before verification and commit. */
	afterRename?(index: number): void;
}

export interface ApplyReport {
	plan_id: string;
	status: EffectPlanRow["status"];
	committed: number;
	skipped_already_committed: number;
	failed: { index: number; reason: string }[];
}

export function planHash(root: string, intents: readonly MoveIntent[]): string {
	return digest({ root, intents });
}

export function buildPlan(args: {
	planId: string;
	episodeId: string;
	skillId: string;
	versionId: number;
	root: string;
	moves: readonly { from: string; to: string }[];
	identities: { [path: string]: FileIdentity };
}): { row: EffectPlanRow; intents: MoveIntent[] } {
	const intents: MoveIntent[] = args.moves.map((move, index) => {
		const expected = args.identities[move.from];
		if (!expected) throw new LatticeError("effect", `no observed identity for ${move.from}`);
		return {
			kind: "rename",
			source: move.from,
			destination: move.to,
			expected,
			destination_must_be_absent: true,
			idempotency_key: `${args.planId}:${index}`,
		};
	});
	const now = Date.now();
	return {
		intents,
		row: {
			plan_id: args.planId,
			episode_id: args.episodeId,
			skill_id: args.skillId,
			version_id: args.versionId,
			root: args.root,
			plan_hash: planHash(args.root, intents),
			intents_json: canonical(intents),
			status: "proposed",
			expires_at: now + PLAN_TTL_MS,
			created_at: now,
			updated_at: now,
		},
	};
}

function sameFile(now: FileIdentity | undefined, expected: FileIdentity): boolean {
	return (
		now !== undefined && now.size === expected.size && now.mtime_ns === expected.mtime_ns && now.ino === expected.ino
	);
}

/** Resolve inside the root and refuse any existing path component that is a link or junction. */
function safePath(root: string, ref: string): string {
	const target = resolveInside(root, ref);
	const parts = ref.split("/");
	for (let i = 1; i <= parts.length; i++) {
		const prefix = resolveInside(root, parts.slice(0, i).join("/"));
		try {
			if (lstatSync(prefix).isSymbolicLink())
				throw new LatticeError("effect", `${parts.slice(0, i).join("/")} is a link`);
		} catch (error) {
			if (error instanceof LatticeError) throw error;
			if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
			throw error;
		}
	}
	return target;
}

function removeIfEmpty(root: string, dirs: readonly string[]): string[] {
	const removed: string[] = [];
	for (const dir of dirs) {
		const path = safePath(root, dir);
		try {
			if (readdirSync(path).length === 0) {
				rmdirSync(path);
				removed.push(dir);
			}
		} catch {
			// Gone already or not empty: leave it.
		}
	}
	return removed;
}

function loadIntents(plan: EffectPlanRow): MoveIntent[] {
	const intents = JSON.parse(plan.intents_json) as MoveIntent[];
	// The stored plan must still be the one that was proposed (and shown to the user).
	if (planHash(plan.root, intents) !== plan.plan_hash) {
		throw new LatticeError("effect", "plan was modified after it was proposed");
	}
	return intents;
}

function finalStatus(store: LatticeStore, plan: EffectPlanRow, total: number): EffectPlanRow["status"] {
	const rows = store.journal(plan.plan_id);
	if (rows.some((row) => row.state === "unresolved" || row.state === "prepared")) return "unresolved";
	const committed = rows.filter((row) => row.state === "committed").length;
	return committed === total ? "applied" : "partial";
}

export function applyPlan(
	store: LatticeStore,
	key: string,
	capability: Capability,
	planId: string,
	hooks: EffectHooks = {},
): ApplyReport {
	const plan = store.plan(planId);
	if (!plan) throw new Error(`no plan ${planId}`);
	verifyCapability(key, capability, "rename", plan.episode_id);
	if (capability.root !== plan.root) throw new LatticeError("effect", "capability root differs from the plan root");
	if (plan.status !== "proposed" && plan.status !== "partial") throw new Error(`plan ${planId} is ${plan.status}`);
	if (plan.status === "proposed" && Date.now() > plan.expires_at) {
		store.setPlanStatus(planId, "expired", { reason: "approval came after the plan expired" });
		throw new Error(`plan ${planId} expired; make a new plan`);
	}
	const intents = loadIntents(plan);
	store.setPlanStatus(planId, "applying", { plan_hash: plan.plan_hash, intents: intents.length });
	const report: ApplyReport = {
		plan_id: planId,
		status: "applying",
		committed: 0,
		skipped_already_committed: 0,
		failed: [],
	};
	for (const [index, intent] of intents.entries()) {
		const existing = store.journalEntry(intent.idempotency_key);
		if (existing?.state === "committed" || existing?.state === "compensated") {
			report.skipped_already_committed++;
			continue;
		}
		if (existing?.state === "unresolved" || existing?.state === "prepared") {
			report.failed.push({ index, reason: `journal entry is ${existing.state}; run recovery first` });
			break;
		}
		store.journalSet(planId, index, intent.idempotency_key, "prepared", { intent });
		hooks.afterPrepared?.(index);
		const fail = (reason: string, created: string[] = []) => {
			const removed = removeIfEmpty(plan.root, [...created].reverse());
			store.journalSet(planId, index, intent.idempotency_key, "failed", { intent, reason, removed_dirs: removed });
			report.failed.push({ index, reason });
		};
		let source: string;
		let destination: string;
		try {
			source = safePath(plan.root, intent.source);
			destination = safePath(plan.root, intent.destination);
		} catch (error) {
			fail((error as Error).message);
			break;
		}
		const now = observeIdentity(source);
		if (!now || now.kind !== "file" || !sameFile(now, intent.expected)) {
			fail("source changed or vanished since the plan was made");
			break;
		}
		if (observeIdentity(destination)) {
			fail("destination exists");
			break;
		}
		const created: string[] = [];
		const parts = intent.destination.split("/").slice(0, -1);
		let parentProblem: string | undefined;
		for (let i = 1; i <= parts.length; i++) {
			const prefix = parts.slice(0, i).join("/");
			const path = safePath(plan.root, prefix);
			const observed = observeIdentity(path);
			if (!observed) {
				mkdirSync(path);
				created.push(prefix);
			} else if (observed.kind !== "dir") {
				parentProblem = `${prefix} exists and is not a directory`;
				break;
			}
		}
		if (parentProblem) {
			fail(parentProblem, created);
			break;
		}
		try {
			renameSync(source, destination);
		} catch (error) {
			// EXDEV (another volume) and permission errors stop the plan; nothing was moved.
			fail(`rename failed: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, created);
			break;
		}
		hooks.afterRename?.(index);
		const moved = observeIdentity(destination);
		// A rename keeps size, modification time and inode, so the full identity must match.
		if (!sameFile(moved, intent.expected) || observeIdentity(source)) {
			store.journalSet(planId, index, intent.idempotency_key, "unresolved", {
				intent,
				created_dirs: created,
				reason: "result did not verify after the rename",
			});
			report.failed.push({ index, reason: "result did not verify after the rename" });
			break;
		}
		store.journalSet(planId, index, intent.idempotency_key, "committed", {
			intent,
			created_dirs: created,
			compensation: { rename: [intent.destination, intent.source], remove_dirs_if_empty: [...created].reverse() },
		});
		report.committed++;
	}
	report.status = finalStatus(store, plan, intents.length);
	store.setPlanStatus(planId, report.status, {
		committed: report.committed,
		skipped: report.skipped_already_committed,
		failed: report.failed,
	});
	return report;
}

export interface CompensationReport {
	plan_id: string;
	status: EffectPlanRow["status"];
	compensated: number;
	unresolved: { index: number; reason: string }[];
}

/** Undo committed moves in reverse order, only where the file is exactly as the plan left it. */
export function compensatePlan(
	store: LatticeStore,
	key: string,
	capability: Capability,
	planId: string,
): CompensationReport {
	const plan = store.plan(planId);
	if (!plan) throw new Error(`no plan ${planId}`);
	verifyCapability(key, capability, "rename", plan.episode_id);
	if (capability.root !== plan.root) throw new LatticeError("effect", "capability root differs from the plan root");
	loadIntents(plan);
	const report: CompensationReport = { plan_id: planId, status: plan.status, compensated: 0, unresolved: [] };
	const committed = store
		.journal(planId)
		.filter((row) => row.state === "committed")
		.sort((a, b) => b.op_index - a.op_index);
	for (const row of committed) {
		const detail = JSON.parse(row.detail_json) as { intent: MoveIntent; created_dirs?: string[] };
		const { intent } = detail;
		const unresolved = (reason: string) => {
			store.journalSet(planId, row.op_index, row.idempotency_key, "unresolved", { ...detail, reason });
			report.unresolved.push({ index: row.op_index, reason });
		};
		let source: string;
		let destination: string;
		try {
			source = safePath(plan.root, intent.source);
			destination = safePath(plan.root, intent.destination);
		} catch (error) {
			unresolved((error as Error).message);
			continue;
		}
		const moved = observeIdentity(destination);
		if (!sameFile(moved, intent.expected)) {
			unresolved("the moved file was changed or removed after the plan; not overwriting");
			continue;
		}
		if (observeIdentity(source)) {
			unresolved("something new exists at the original path; not overwriting");
			continue;
		}
		const parent = dirname(intent.source);
		if (parent !== "." && observeIdentity(safePath(plan.root, parent))?.kind !== "dir") {
			unresolved("the original directory is gone");
			continue;
		}
		renameSync(destination, source);
		const removed = removeIfEmpty(plan.root, [...(detail.created_dirs ?? [])].reverse());
		store.journalSet(planId, row.op_index, row.idempotency_key, "compensated", { ...detail, removed_dirs: removed });
		report.compensated++;
	}
	report.status = report.unresolved.length > 0 ? "unresolved" : "compensated";
	store.setPlanStatus(planId, report.status, { compensated: report.compensated, unresolved: report.unresolved });
	return report;
}

export interface ReconcileEntry {
	plan_id: string;
	op_index: number;
	resolution: "unperformed" | "committed" | "unresolved";
}

/**
 * Crash reconciliation (spec section 43.7) for journal entries left `prepared`:
 * original still in place and destination absent means the move never happened (`unperformed`,
 * safe to apply again); the same file at the destination and nothing at the source means it did
 * (`committed`; directories it may have created are not known, so undo will not remove them);
 * anything else is ambiguous (`unresolved`), the evidence is kept and the plan is paused.
 */
export function reconcileEffects(store: LatticeStore): ReconcileEntry[] {
	const entries: ReconcileEntry[] = [];
	const touched = new Set<string>();
	for (const row of store.pendingJournal()) {
		const plan = store.plan(row.plan_id);
		if (!plan) continue;
		const { intent } = JSON.parse(row.detail_json) as { intent: MoveIntent };
		touched.add(plan.plan_id);
		let resolution: ReconcileEntry["resolution"];
		try {
			const source = observeIdentity(resolveInside(plan.root, intent.source));
			const destination = observeIdentity(resolveInside(plan.root, intent.destination));
			if (sameFile(source, intent.expected) && !destination) resolution = "unperformed";
			else if (!source && sameFile(destination, intent.expected)) resolution = "committed";
			else resolution = "unresolved";
		} catch {
			resolution = "unresolved";
		}
		store.journalSet(plan.plan_id, row.op_index, row.idempotency_key, resolution, {
			intent,
			created_dirs: [],
			reason: "reconciled after an interrupted apply",
		});
		entries.push({ plan_id: plan.plan_id, op_index: row.op_index, resolution });
	}
	for (const plan of store.plans("applying")) touched.add(plan.plan_id);
	for (const planId of touched) {
		const plan = store.plan(planId)!;
		store.setPlanStatus(planId, finalStatus(store, plan, loadIntents(plan).length), { reason: "reconciled" });
	}
	return entries;
}
