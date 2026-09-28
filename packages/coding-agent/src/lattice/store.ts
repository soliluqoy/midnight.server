import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { canonical, digest, sha256 } from "./canonical.ts";
import { type Contract, evaluatorHash } from "./contracts.ts";
import { faultPoint } from "./fault.ts";
import { type LibrarySkill, librarySkillHash, type Program, programHash } from "./ir.ts";
import { PRIMITIVE_LIBRARY_HASH } from "./primitives.ts";

/**
 * Persistent state (spec sections 7, 15, 44). SQLite in WAL mode with foreign keys and full
 * synchronous commits. Large bytes live in a content-addressed artifact directory; the database
 * keeps hashes. Version activation is a compare-and-swap on `active_heads_v1`; rollback is a
 * pointer change; every decision is appended to a hash-chained audit log.
 */
export const KERNEL_VERSION = "0.1.0";
const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contracts_v1 (
	contract_id TEXT NOT NULL,
	revision INTEGER NOT NULL CHECK (revision > 0),
	evaluator_hash TEXT NOT NULL,
	PRIMARY KEY (contract_id, revision)
);
CREATE TABLE IF NOT EXISTS programs_v1 (
	program_hash TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('ir', 'policy')),
	canonical_ir TEXT NOT NULL,
	ir_version INTEGER NOT NULL CHECK (ir_version > 0),
	primitives_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS versions_v1 (
	version_id INTEGER PRIMARY KEY,
	skill_id TEXT NOT NULL,
	contract_id TEXT NOT NULL,
	contract_revision INTEGER NOT NULL,
	program_hash TEXT NOT NULL REFERENCES programs_v1(program_hash),
	parent_version INTEGER,
	seed INTEGER NOT NULL CHECK (seed IN (0, 1)),
	release_eligible INTEGER NOT NULL CHECK (release_eligible IN (0, 1)),
	status TEXT NOT NULL CHECK (status IN ('canary', 'champion', 'retired', 'invalid')),
	campaign_id TEXT,
	report_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	UNIQUE (skill_id, version_id),
	CHECK (seed = 1 OR parent_version IS NOT NULL),
	FOREIGN KEY (contract_id, contract_revision) REFERENCES contracts_v1(contract_id, revision),
	FOREIGN KEY (skill_id, parent_version) REFERENCES versions_v1(skill_id, version_id)
);
CREATE TABLE IF NOT EXISTS active_heads_v1 (
	skill_id TEXT PRIMARY KEY,
	version_id INTEGER NOT NULL,
	promotion_enabled INTEGER NOT NULL DEFAULT 1 CHECK (promotion_enabled IN (0, 1)),
	FOREIGN KEY (skill_id, version_id) REFERENCES versions_v1(skill_id, version_id)
);
CREATE TABLE IF NOT EXISTS consumed_releases_v1 (
	release_set_id TEXT PRIMARY KEY,
	campaign_id TEXT NOT NULL UNIQUE,
	program_hash TEXT NOT NULL REFERENCES programs_v1(program_hash),
	verdict TEXT NOT NULL CHECK (verdict IN ('reserved', 'pass', 'fail', 'incomplete')),
	evidence_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaigns (
	campaign_id TEXT PRIMARY KEY,
	skill_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	parent_version INTEGER NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'promoted', 'rejected', 'incomplete', 'no_candidate', 'aborted')),
	record_json TEXT NOT NULL,
	promoted_version INTEGER UNIQUE,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS evaluations (
	evaluation_id INTEGER PRIMARY KEY,
	campaign_id TEXT,
	program_hash TEXT NOT NULL,
	suite TEXT NOT NULL,
	metrics_json TEXT NOT NULL,
	verdict TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS episodes (
	episode_id TEXT PRIMARY KEY,
	contract_id TEXT NOT NULL,
	skill_id TEXT,
	version_id INTEGER,
	goal_json TEXT NOT NULL,
	input_hash TEXT NOT NULL,
	plan_json TEXT NOT NULL,
	result_json TEXT,
	evaluation_json TEXT NOT NULL,
	status TEXT NOT NULL,
	runtime_ms REAL NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS regressions (
	case_id TEXT PRIMARY KEY,
	contract_id TEXT NOT NULL,
	contract_revision INTEGER NOT NULL,
	input_hash TEXT NOT NULL,
	input_json TEXT NOT NULL,
	failed_invariant TEXT NOT NULL,
	candidate_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	UNIQUE (contract_id, contract_revision, input_hash)
);
CREATE TABLE IF NOT EXISTS facts (
	fact_id TEXT PRIMARY KEY,
	subject TEXT NOT NULL,
	predicate TEXT NOT NULL,
	object_json TEXT NOT NULL,
	confidence REAL NOT NULL,
	provenance TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS library_v1 (
	skill_hash TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	definition_json TEXT NOT NULL,
	report_json TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
	hash TEXT PRIMARY KEY,
	mime TEXT NOT NULL,
	size INTEGER NOT NULL,
	producer TEXT NOT NULL,
	retention TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS compiled_v1 (
	program_hash TEXT PRIMARY KEY REFERENCES programs_v1(program_hash),
	bytecode_hash TEXT NOT NULL REFERENCES artifacts(hash),
	compiler_version INTEGER NOT NULL,
	report_json TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cache (
	key TEXT PRIMARY KEY,
	version_id INTEGER NOT NULL,
	output_json TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
	reservation_id TEXT PRIMARY KEY,
	day TEXT NOT NULL,
	reserved_ms REAL NOT NULL,
	consumed_ms REAL,
	state TEXT NOT NULL CHECK (state IN ('reserved', 'reconciled')),
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bandit (arm TEXT PRIMARY KEY, trials INTEGER NOT NULL, reward REAL NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints (campaign_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS effect_plans (
	plan_id TEXT PRIMARY KEY,
	episode_id TEXT NOT NULL,
	skill_id TEXT NOT NULL,
	version_id INTEGER NOT NULL,
	root TEXT NOT NULL,
	plan_hash TEXT NOT NULL,
	intents_json TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('proposed', 'applying', 'applied', 'partial', 'compensated', 'unresolved', 'expired')),
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS effect_journal (
	idempotency_key TEXT PRIMARY KEY,
	plan_id TEXT NOT NULL REFERENCES effect_plans(plan_id),
	op_index INTEGER NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('prepared', 'committed', 'failed', 'unperformed', 'compensated', 'unresolved')),
	detail_json TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (plan_id, op_index)
);
CREATE TABLE IF NOT EXISTS audit (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	kind TEXT NOT NULL,
	subject TEXT NOT NULL,
	payload TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	previous TEXT NOT NULL,
	digest TEXT NOT NULL
);
`;

const GENESIS = "0".repeat(64);

export function newId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export interface VersionRow {
	version_id: number;
	skill_id: string;
	contract_id: string;
	contract_revision: number;
	program_hash: string;
	parent_version: number | null;
	seed: number;
	status: string;
	campaign_id: string | null;
	report_json: string;
	created_at: number;
}

export interface Head {
	skillId: string;
	version: VersionRow;
	program: Program;
	promotionEnabled: boolean;
}

export interface IntegrityReport {
	ok: boolean;
	problems: string[];
	/** First audit sequence number that failed verification, if any. */
	auditBrokenAt?: number;
	/** Active versions whose stored program no longer matches its hash. */
	corruptHeads: string[];
}

export class LatticeStore {
	readonly dataDir: string;
	readonly db: DatabaseSync;
	/** Set when an integrity check failed; promotion stops until recovery (invariant 10). */
	paused: string | undefined;

	private constructor(dataDir: string, db: DatabaseSync) {
		this.dataDir = dataDir;
		this.db = db;
	}

	/**
	 * Open or create a store. An existing database is first verified through a read-only
	 * connection (spec section 19.3); a failed check opens the store paused.
	 */
	static open(dataDir: string): LatticeStore {
		mkdirSync(join(dataDir, "artifacts"), { recursive: true });
		const path = join(dataDir, "lattice.db");
		let precheck: IntegrityReport | undefined;
		if (existsSync(path)) {
			const readonly = new DatabaseSync(path, { readOnly: true });
			try {
				const hasAudit = readonly
					.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit'")
					.get();
				if (hasAudit) precheck = verifyDatabase(readonly, dataDir);
			} finally {
				readonly.close();
			}
		}
		const db = new DatabaseSync(path);
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA synchronous = FULL");
		db.exec("PRAGMA foreign_keys = ON");
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec(SCHEMA);
		const store = new LatticeStore(dataDir, db);
		const version = store.getMeta("schema_version");
		if (version === undefined) {
			store.setMeta("schema_version", String(SCHEMA_VERSION));
			store.setMeta("installation_id", newId("inst"));
			store.setMeta("kernel_version", KERNEL_VERSION);
			store.audit("initialize", "store", { kernel_version: KERNEL_VERSION, schema_version: SCHEMA_VERSION });
		} else if (Number(version) !== SCHEMA_VERSION) {
			db.close();
			throw new Error(`unsupported store schema ${version}`);
		}
		if (precheck && !precheck.ok) store.paused = precheck.problems.join("; ");
		return store;
	}

	/** An isolated in-memory store for tests and self-tests. */
	static memory(dataDir: string): LatticeStore {
		mkdirSync(join(dataDir, "artifacts"), { recursive: true });
		const db = new DatabaseSync(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		db.exec(SCHEMA);
		const store = new LatticeStore(dataDir, db);
		store.setMeta("schema_version", String(SCHEMA_VERSION));
		store.setMeta("installation_id", newId("inst"));
		store.audit("initialize", "store", { kernel_version: KERNEL_VERSION, schema_version: SCHEMA_VERSION });
		return store;
	}

	close(): void {
		this.db.close();
	}

	private get<R>(sql: string, ...params: SQLInputValue[]): R | undefined {
		return this.db.prepare(sql).get(...params) as R | undefined;
	}

	private all<R>(sql: string, ...params: SQLInputValue[]): R[] {
		return this.db.prepare(sql).all(...params) as R[];
	}

	private run(
		sql: string,
		...params: SQLInputValue[]
	): { lastInsertRowid: number | bigint; changes: number | bigint } {
		return this.db.prepare(sql).run(...params);
	}

	/** One writer at a time: BEGIN IMMEDIATE takes the write lock before any read. */
	transaction<T>(body: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = body();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	getMeta(key: string): string | undefined {
		return this.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value;
	}

	setMeta(key: string, value: string): void {
		this.run(
			"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			key,
			value,
		);
	}

	/* ----------------------------------------------------------------------------- audit */

	audit(kind: string, subject: string, payload: unknown): void {
		const previous =
			this.get<{ digest: string }>("SELECT digest FROM audit ORDER BY seq DESC LIMIT 1")?.digest ?? GENESIS;
		const serialized = canonical(payload);
		const createdAt = Date.now();
		this.run(
			"INSERT INTO audit (kind, subject, payload, created_at, previous, digest) VALUES (?, ?, ?, ?, ?, ?)",
			kind,
			subject,
			serialized,
			createdAt,
			previous,
			digest([previous, createdAt, kind, subject, serialized]),
		);
	}

	auditLog(
		subject?: string,
		limit = 50,
	): { seq: number; kind: string; subject: string; payload: unknown; created_at: number }[] {
		const rows = subject
			? this.all<{ seq: number; kind: string; subject: string; payload: string; created_at: number }>(
					"SELECT seq, kind, subject, payload, created_at FROM audit WHERE subject = ? ORDER BY seq DESC LIMIT ?",
					subject,
					limit,
				)
			: this.all<{ seq: number; kind: string; subject: string; payload: string; created_at: number }>(
					"SELECT seq, kind, subject, payload, created_at FROM audit ORDER BY seq DESC LIMIT ?",
					limit,
				);
		return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown }));
	}

	auditRoot(): string {
		return this.get<{ digest: string }>("SELECT digest FROM audit ORDER BY seq DESC LIMIT 1")?.digest ?? GENESIS;
	}

	verify(): IntegrityReport {
		return verifyDatabase(this.db, this.dataDir);
	}

	private requireUnpaused(): void {
		if (this.paused) throw new Error(`promotion is stopped: integrity failure (${this.paused})`);
	}

	/* ------------------------------------------------------------------ contracts, programs */

	/**
	 * Register a contract revision. If the stored evaluator hash differs, the contract changed
	 * without a revision bump; the kernel refuses rather than silently re-judging old evidence.
	 */
	ensureContract(contract: Contract): void {
		this.ensureContractRow(contract.id, contract.revision, evaluatorHash(contract));
	}

	ensureContractRow(id: string, revision: number, hash: string): void {
		const contract = { id, revision };
		const row = this.get<{ evaluator_hash: string }>(
			"SELECT evaluator_hash FROM contracts_v1 WHERE contract_id = ? AND revision = ?",
			contract.id,
			contract.revision,
		);
		if (!row) {
			this.run(
				"INSERT INTO contracts_v1 (contract_id, revision, evaluator_hash) VALUES (?, ?, ?)",
				contract.id,
				contract.revision,
				hash,
			);
			this.audit("contract_registered", contract.id, { revision: contract.revision, evaluator_hash: hash });
		} else if (row.evaluator_hash !== hash) {
			throw new Error(
				`contract ${contract.id} revision ${contract.revision} changed without a new revision (evaluator hash mismatch)`,
			);
		}
	}

	putProgram(program: Program): string {
		const hash = programHash(program, PRIMITIVE_LIBRARY_HASH);
		this.run(
			"INSERT OR IGNORE INTO programs_v1 (program_hash, kind, canonical_ir, ir_version, primitives_hash) VALUES (?, 'ir', ?, ?, ?)",
			hash,
			canonical(program),
			program.ir_version,
			PRIMITIVE_LIBRARY_HASH,
		);
		return hash;
	}

	putPolicyRecord(record: unknown): string {
		const hash = digest(record);
		this.run(
			"INSERT OR IGNORE INTO programs_v1 (program_hash, kind, canonical_ir, ir_version, primitives_hash) VALUES (?, 'policy', ?, 1, ?)",
			hash,
			canonical(record),
			PRIMITIVE_LIBRARY_HASH,
		);
		return hash;
	}

	programText(hash: string): string | undefined {
		return this.get<{ canonical_ir: string }>("SELECT canonical_ir FROM programs_v1 WHERE program_hash = ?", hash)
			?.canonical_ir;
	}

	/* ---------------------------------------------------------------- versions and heads */

	/** Install an explicitly marked seed (invariant 5) as the first champion of a skill. */
	installSeed(
		skillId: string,
		contract: { id: string; revision: number },
		program: Program | unknown,
		kind: "ir" | "policy" = "ir",
	): number {
		return this.transaction(() => {
			const existing = this.get<{ version_id: number }>(
				"SELECT version_id FROM active_heads_v1 WHERE skill_id = ?",
				skillId,
			);
			if (existing) return existing.version_id;
			const hash = kind === "ir" ? this.putProgram(program as Program) : this.putPolicyRecord(program);
			const inserted = this.run(
				`INSERT INTO versions_v1 (skill_id, contract_id, contract_revision, program_hash, parent_version, seed,
					release_eligible, status, campaign_id, report_json, created_at)
				 VALUES (?, ?, ?, ?, NULL, 1, 1, 'champion', NULL, ?, ?)`,
				skillId,
				contract.id,
				contract.revision,
				hash,
				canonical({ kind: "seed", author: "human" }),
				Date.now(),
			);
			const versionId = Number(inserted.lastInsertRowid);
			this.run("INSERT INTO active_heads_v1 (skill_id, version_id) VALUES (?, ?)", skillId, versionId);
			this.audit("seed", skillId, { version: versionId, program_hash: hash });
			return versionId;
		});
	}

	version(versionId: number): VersionRow | undefined {
		return this.get<VersionRow>("SELECT * FROM versions_v1 WHERE version_id = ?", versionId);
	}

	versions(skillId: string): VersionRow[] {
		return this.all<VersionRow>("SELECT * FROM versions_v1 WHERE skill_id = ? ORDER BY version_id", skillId);
	}

	skills(): { skill_id: string; version_id: number; promotion_enabled: number }[] {
		return this.all("SELECT skill_id, version_id, promotion_enabled FROM active_heads_v1 ORDER BY skill_id");
	}

	head(skillId: string): Head | undefined {
		const row = this.get<{ version_id: number; promotion_enabled: number }>(
			"SELECT version_id, promotion_enabled FROM active_heads_v1 WHERE skill_id = ?",
			skillId,
		);
		if (!row) return undefined;
		const version = this.version(row.version_id)!;
		const text = this.programText(version.program_hash)!;
		return {
			skillId,
			version,
			program: JSON.parse(text) as Program,
			promotionEnabled: row.promotion_enabled === 1,
		};
	}

	headRecord<R>(skillId: string): { version: VersionRow; record: R } | undefined {
		const row = this.get<{ version_id: number }>(
			"SELECT version_id FROM active_heads_v1 WHERE skill_id = ?",
			skillId,
		);
		if (!row) return undefined;
		const version = this.version(row.version_id)!;
		return { version, record: JSON.parse(this.programText(version.program_hash)!) as R };
	}

	/**
	 * Compare-and-swap promotion (spec section 15.3): inside one immediate transaction, verify
	 * the expected parent is still active, insert the candidate version, move the pointer, mark
	 * the campaign and append the audit record. Any failure leaves the old version active.
	 */
	promote(args: {
		skillId: string;
		expectedParent: number;
		program: Program | unknown;
		kind?: "ir" | "policy";
		campaignId: string;
		report: unknown;
	}): number {
		this.requireUnpaused();
		const promoted = this.transaction(() => {
			const head = this.get<{ version_id: number; promotion_enabled: number }>(
				"SELECT version_id, promotion_enabled FROM active_heads_v1 WHERE skill_id = ?",
				args.skillId,
			);
			if (!head) throw new Error(`no active version for ${args.skillId}`);
			if (head.version_id !== args.expectedParent) throw new Error("active version changed; campaign is stale");
			if (head.promotion_enabled !== 1)
				throw new Error(`promotion is disabled for ${args.skillId} until a diagnostic run passes`);
			const parent = this.version(head.version_id)!;
			const hash =
				args.kind === "policy" ? this.putPolicyRecord(args.program) : this.putProgram(args.program as Program);
			const inserted = this.run(
				`INSERT INTO versions_v1 (skill_id, contract_id, contract_revision, program_hash, parent_version, seed,
					release_eligible, status, campaign_id, report_json, created_at)
				 VALUES (?, ?, ?, ?, ?, 0, 1, 'canary', ?, ?, ?)`,
				args.skillId,
				parent.contract_id,
				parent.contract_revision,
				hash,
				parent.version_id,
				args.campaignId,
				canonical(args.report),
				Date.now(),
			);
			const versionId = Number(inserted.lastInsertRowid);
			this.run("UPDATE active_heads_v1 SET version_id = ? WHERE skill_id = ?", versionId, args.skillId);
			this.run(
				"UPDATE campaigns SET status = 'promoted', promoted_version = ? WHERE campaign_id = ?",
				versionId,
				args.campaignId,
			);
			this.audit("promote", args.skillId, {
				from: parent.version_id,
				to: versionId,
				program_hash: hash,
				campaign: args.campaignId,
			});
			faultPoint("promote-before-commit");
			return versionId;
		});
		faultPoint("promote-after-commit");
		return promoted;
	}

	/** A canary that kept agreeing with its parent becomes the champion; the parent is retired but kept. */
	confirmChampion(skillId: string, versionId: number, evidence: unknown): void {
		this.transaction(() => {
			const version = this.version(versionId);
			if (!version || version.skill_id !== skillId || version.status !== "canary") return;
			this.run("UPDATE versions_v1 SET status = 'champion' WHERE version_id = ?", versionId);
			if (version.parent_version !== null) {
				this.run("UPDATE versions_v1 SET status = 'retired' WHERE version_id = ?", version.parent_version);
			}
			this.audit("champion", skillId, { version: versionId, evidence });
		});
	}

	/**
	 * Rollback is a pointer change, not deletion (section 15.4). Without `toVersion`, the target is
	 * the active version's parent; an explicit target must be an ancestor that is not invalid.
	 */
	rollback(skillId: string, reason: string, toVersion?: number): { from: number; to: number } {
		return this.transaction(() => {
			const head = this.get<{ version_id: number }>(
				"SELECT version_id FROM active_heads_v1 WHERE skill_id = ?",
				skillId,
			);
			if (!head) throw new Error(`no active version for ${skillId}`);
			const current = this.version(head.version_id)!;
			let target: VersionRow | undefined;
			if (toVersion === undefined) {
				if (current.parent_version === null) throw new Error("seed version has no parent");
				target = this.version(current.parent_version);
			} else {
				for (let cursor: VersionRow | undefined = current; cursor; ) {
					if (cursor.version_id === toVersion) {
						target = cursor;
						break;
					}
					cursor = cursor.parent_version === null ? undefined : this.version(cursor.parent_version);
				}
				if (!target) throw new Error(`version ${toVersion} is not an ancestor of the active version`);
			}
			if (!target || target.status === "invalid") throw new Error("rollback target is invalid");
			this.run("UPDATE active_heads_v1 SET version_id = ? WHERE skill_id = ?", target.version_id, skillId);
			if (current.status !== "invalid")
				this.run("UPDATE versions_v1 SET status = 'retired' WHERE version_id = ?", current.version_id);
			this.run("UPDATE versions_v1 SET status = 'champion' WHERE version_id = ?", target.version_id);
			this.run("DELETE FROM cache WHERE version_id = ?", current.version_id);
			this.audit("rollback", skillId, { from: current.version_id, to: target.version_id, reason });
			return { from: current.version_id, to: target.version_id };
		});
	}

	setPromotionEnabled(skillId: string, enabled: boolean, reason: string): void {
		this.run("UPDATE active_heads_v1 SET promotion_enabled = ? WHERE skill_id = ?", enabled ? 1 : 0, skillId);
		this.audit(enabled ? "promotion_enabled" : "promotion_disabled", skillId, { reason });
	}

	/**
	 * Corruption recovery (spec section 19.4): mark each corrupt active version invalid, restore
	 * its last valid ancestor, record it, and disable promotion for that skill until a diagnostic
	 * run passes.
	 */
	recover(): { skillId: string; from: number; to: number }[] {
		const report = this.verify();
		const recovered: { skillId: string; from: number; to: number }[] = [];
		for (const skillId of report.corruptHeads) {
			const head = this.get<{ version_id: number }>(
				"SELECT version_id FROM active_heads_v1 WHERE skill_id = ?",
				skillId,
			)!;
			let cursor = this.version(head.version_id);
			const invalid: number[] = [];
			while (cursor && !this.programIntact(cursor.program_hash)) {
				invalid.push(cursor.version_id);
				cursor = cursor.parent_version === null ? undefined : this.version(cursor.parent_version);
			}
			if (!cursor) throw new Error(`no valid ancestor for ${skillId}; restore from a snapshot`);
			const target = cursor;
			this.transaction(() => {
				for (const versionId of invalid)
					this.run("UPDATE versions_v1 SET status = 'invalid' WHERE version_id = ?", versionId);
				this.run(
					"UPDATE active_heads_v1 SET version_id = ?, promotion_enabled = 0 WHERE skill_id = ?",
					target.version_id,
					skillId,
				);
				this.run("UPDATE versions_v1 SET status = 'champion' WHERE version_id = ?", target.version_id);
				this.audit("recovery", skillId, { invalid, restored: target.version_id });
			});
			recovered.push({ skillId, from: head.version_id, to: target.version_id });
		}
		if (report.auditBrokenAt === undefined && report.problems.every((problem) => !problem.startsWith("audit"))) {
			this.paused = undefined;
		}
		return recovered;
	}

	private programIntact(hash: string): boolean {
		const row = this.get<{ kind: string; canonical_ir: string; primitives_hash: string }>(
			"SELECT kind, canonical_ir, primitives_hash FROM programs_v1 WHERE program_hash = ?",
			hash,
		);
		return row !== undefined && recomputeHash(row) === hash;
	}

	/* ---------------------------------------------------------------- campaigns, releases */

	startCampaign(args: {
		campaignId: string;
		skillId: string;
		kind: string;
		parentVersion: number;
		record: unknown;
	}): void {
		this.run(
			"INSERT INTO campaigns (campaign_id, skill_id, kind, parent_version, status, record_json, created_at) VALUES (?, ?, ?, ?, 'running', ?, ?)",
			args.campaignId,
			args.skillId,
			args.kind,
			args.parentVersion,
			canonical(args.record),
			Date.now(),
		);
		this.markCampaignOwner(args.campaignId);
		this.audit("campaign_started", args.skillId, { campaign: args.campaignId, parent: args.parentVersion });
	}

	/** The process running a campaign, so a later open can tell a live campaign from a dead one. */
	markCampaignOwner(campaignId: string): void {
		this.setMeta(`campaign_owner:${campaignId}`, String(process.pid));
	}

	finishCampaign(campaignId: string, status: string, record: unknown): void {
		this.run(
			"UPDATE campaigns SET status = CASE WHEN status = 'promoted' THEN status ELSE ? END, record_json = ? WHERE campaign_id = ?",
			status,
			canonical(record),
			campaignId,
		);
		this.run("DELETE FROM meta WHERE key = ?", `campaign_owner:${campaignId}`);
	}

	/**
	 * Pause for interactive work (spec section 42.5): the checkpoint and the `paused` status commit
	 * together, so a crash during cancellation leaves the campaign either running (and later
	 * reconciled) or paused with a checkpoint it can resume from, never paused without one.
	 */
	pauseCampaign(campaignId: string, skillId: string, state: unknown, record: unknown, detail: unknown): void {
		this.transaction(() => {
			this.saveCheckpoint(campaignId, state);
			this.run(
				"UPDATE campaigns SET status = 'paused', record_json = ? WHERE campaign_id = ?",
				canonical(record),
				campaignId,
			);
			this.run("DELETE FROM meta WHERE key = ?", `campaign_owner:${campaignId}`);
			this.audit("campaign_paused", skillId, detail);
			faultPoint("pause-before-commit");
		});
		faultPoint("pause-after-commit");
	}

	/**
	 * Campaigns left `running` by a process that no longer exists (spec section 46.2). One with a
	 * search checkpoint becomes `paused` and can resume from it; any other is `aborted`. Neither
	 * promotes anything: promotion is a separate compare-and-swap that either committed or did not.
	 * A campaign whose owner is still alive is left alone. Process IDs can be reused, so a crashed
	 * campaign may stay `running` until its old ID is free; it never becomes resolved wrongly.
	 */
	reconcileCampaigns(): { campaign_id: string; resolution: "paused" | "aborted" }[] {
		const out: { campaign_id: string; resolution: "paused" | "aborted" }[] = [];
		const running = this.all<{ campaign_id: string; skill_id: string }>(
			"SELECT campaign_id, skill_id FROM campaigns WHERE status = 'running'",
		);
		for (const campaign of running) {
			const owner = Number(this.getMeta(`campaign_owner:${campaign.campaign_id}`));
			if (Number.isInteger(owner) && owner > 0 && processAlive(owner)) continue;
			const checkpoint = this.loadCheckpoint<{ stage?: string }>(campaign.campaign_id);
			const resolution = checkpoint?.stage === "search" ? "paused" : "aborted";
			this.transaction(() => {
				this.run("UPDATE campaigns SET status = ? WHERE campaign_id = ?", resolution, campaign.campaign_id);
				this.run("DELETE FROM meta WHERE key = ?", `campaign_owner:${campaign.campaign_id}`);
				this.audit("campaign_interrupted", campaign.skill_id, {
					campaign: campaign.campaign_id,
					resolution,
					reason:
						resolution === "paused"
							? "its process ended; resumable from the last search checkpoint"
							: "its process ended before a resumable checkpoint",
				});
			});
			out.push({ campaign_id: campaign.campaign_id, resolution });
		}
		return out;
	}

	campaign(
		campaignId: string,
	): { campaign_id: string; skill_id: string; kind: string; parent_version: number; status: string } | undefined {
		return this.get(
			"SELECT campaign_id, skill_id, kind, parent_version, status FROM campaigns WHERE campaign_id = ?",
			campaignId,
		);
	}

	setCampaignStatus(campaignId: string, status: string, reason: string): void {
		this.run("UPDATE campaigns SET status = ? WHERE campaign_id = ?", status, campaignId);
		this.audit(`campaign_${status}`, campaignId, { reason });
	}

	campaigns(
		skillId: string,
	): { campaign_id: string; kind: string; status: string; record_json: string; created_at: number }[] {
		return this.all("SELECT * FROM campaigns WHERE skill_id = ? ORDER BY created_at, campaign_id", skillId);
	}

	/** Number of release sets already reserved for a skill family, used to pick the next fresh set. */
	releaseSetsUsed(prefix: string): number {
		return (
			this.get<{ n: number }>(
				"SELECT COUNT(*) AS n FROM consumed_releases_v1 WHERE release_set_id LIKE ? ESCAPE '\\'",
				`${prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
			)?.n ?? 0
		);
	}

	/**
	 * Durably reserve a release set for one frozen candidate before any release case is read.
	 * A crash after this point leaves the set consumed, so it cannot be retried until it looks good.
	 */
	reserveRelease(releaseSetId: string, campaignId: string, programHash: string): void {
		const used = this.get<{ verdict: string }>(
			"SELECT verdict FROM consumed_releases_v1 WHERE release_set_id = ?",
			releaseSetId,
		);
		if (used) throw new Error(`release set ${releaseSetId} already consumed (${used.verdict})`);
		this.run(
			"INSERT INTO consumed_releases_v1 (release_set_id, campaign_id, program_hash, verdict, evidence_hash) VALUES (?, ?, ?, 'reserved', '')",
			releaseSetId,
			campaignId,
			programHash,
		);
		this.audit("release_reserved", releaseSetId, { campaign: campaignId, program_hash: programHash });
	}

	finalizeRelease(releaseSetId: string, verdict: "pass" | "fail" | "incomplete", evidence: unknown): void {
		const evidenceHash = digest(evidence);
		this.run(
			"UPDATE consumed_releases_v1 SET verdict = ?, evidence_hash = ? WHERE release_set_id = ? AND verdict = 'reserved'",
			verdict,
			evidenceHash,
			releaseSetId,
		);
		this.audit("release_evaluation", releaseSetId, { verdict, evidence_hash: evidenceHash, evidence });
	}

	recordEvaluation(
		campaignId: string | null,
		program: string,
		suite: string,
		metrics: unknown,
		verdict: string,
	): void {
		this.run(
			"INSERT INTO evaluations (campaign_id, program_hash, suite, metrics_json, verdict, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			campaignId,
			program,
			suite,
			canonical(metrics),
			verdict,
			Date.now(),
		);
	}

	saveCheckpoint(campaignId: string, state: unknown): void {
		this.run(
			"INSERT INTO checkpoints (campaign_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(campaign_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
			campaignId,
			canonical(state),
			Date.now(),
		);
	}

	loadCheckpoint<S>(campaignId: string): S | undefined {
		const row = this.get<{ state_json: string }>(
			"SELECT state_json FROM checkpoints WHERE campaign_id = ?",
			campaignId,
		);
		return row ? (JSON.parse(row.state_json) as S) : undefined;
	}

	/* ----------------------------------------------------------------- episodes and memory */

	recordEpisode(episode: {
		episodeId: string;
		contractId: string;
		skillId?: string;
		versionId?: number;
		goal: unknown;
		inputHash: string;
		plan: unknown;
		result: unknown;
		evaluation: unknown;
		status: string;
		runtimeMs: number;
	}): void {
		this.run(
			`INSERT INTO episodes (episode_id, contract_id, skill_id, version_id, goal_json, input_hash, plan_json, result_json,
				evaluation_json, status, runtime_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			episode.episodeId,
			episode.contractId,
			episode.skillId ?? null,
			episode.versionId ?? null,
			canonical(episode.goal),
			episode.inputHash,
			canonical(episode.plan),
			canonical(episode.result),
			canonical(episode.evaluation),
			episode.status,
			episode.runtimeMs,
			Date.now(),
		);
	}

	episode(episodeId: string):
		| {
				episode_id: string;
				contract_id: string;
				skill_id: string | null;
				version_id: number | null;
				goal_json: string;
				input_hash: string;
				plan_json: string;
				result_json: string;
				evaluation_json: string;
				status: string;
				runtime_ms: number;
				created_at: number;
		  }
		| undefined {
		return this.get("SELECT * FROM episodes WHERE episode_id = ?", episodeId);
	}

	episodes(
		contractId: string,
		limit = 200,
	): { episode_id: string; input_hash: string; status: string; version_id: number | null; goal_json: string }[] {
		return this.all(
			"SELECT episode_id, input_hash, status, version_id, goal_json FROM episodes WHERE contract_id = ? ORDER BY created_at DESC LIMIT ?",
			contractId,
			limit,
		);
	}

	countEpisodes(contractId: string, sinceMs = 0): number {
		return (
			this.get<{ n: number }>(
				"SELECT COUNT(*) AS n FROM episodes WHERE contract_id = ? AND created_at >= ?",
				contractId,
				sinceMs,
			)?.n ?? 0
		);
	}

	addRegression(contract: Contract, input: unknown, failedInvariant: string, candidateHash: string): boolean {
		const inputHash = digest(input);
		const result = this.run(
			`INSERT OR IGNORE INTO regressions (case_id, contract_id, contract_revision, input_hash, input_json, failed_invariant,
				candidate_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			newId("case"),
			contract.id,
			contract.revision,
			inputHash,
			canonical(input),
			failedInvariant,
			candidateHash,
			Date.now(),
		);
		if (Number(result.changes) > 0) {
			this.audit("counterexample", contract.id, {
				input_hash: inputHash,
				failed_invariant: failedInvariant,
				candidate: candidateHash,
			});
		}
		return Number(result.changes) > 0;
	}

	regressions(contract: Contract): unknown[] {
		return this.all<{ input_json: string }>(
			"SELECT input_json FROM regressions WHERE contract_id = ? AND contract_revision = ? ORDER BY created_at, case_id",
			contract.id,
			contract.revision,
		).map((row) => JSON.parse(row.input_json) as unknown);
	}

	addFact(fact: {
		subject: string;
		predicate: string;
		object: unknown;
		confidence: number;
		provenance: string;
		ttlMs?: number;
	}): void {
		const now = Date.now();
		this.run(
			"INSERT INTO facts (fact_id, subject, predicate, object_json, confidence, provenance, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			newId("fact"),
			fact.subject,
			fact.predicate,
			canonical(fact.object),
			fact.confidence,
			fact.provenance,
			now,
			fact.ttlMs === undefined ? null : now + fact.ttlMs,
		);
	}

	facts(subject: string): { predicate: string; object: unknown; confidence: number; provenance: string }[] {
		return this.all<{ predicate: string; object_json: string; confidence: number; provenance: string }>(
			"SELECT predicate, object_json, confidence, provenance FROM facts WHERE subject = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at",
			subject,
			Date.now(),
		).map((row) => ({ ...row, object: JSON.parse(row.object_json) as unknown }));
	}

	/* ------------------------------------------------------------------------ effects */

	createPlan(plan: EffectPlanRow): void {
		this.run(
			`INSERT INTO effect_plans (plan_id, episode_id, skill_id, version_id, root, plan_hash, intents_json, status, expires_at,
				created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			plan.plan_id,
			plan.episode_id,
			plan.skill_id,
			plan.version_id,
			plan.root,
			plan.plan_hash,
			plan.intents_json,
			plan.status,
			plan.expires_at,
			plan.created_at,
			plan.updated_at,
		);
		this.audit("effect_plan_proposed", plan.plan_id, {
			plan_hash: plan.plan_hash,
			root: plan.root,
			skill: plan.skill_id,
		});
	}

	plan(planId: string): EffectPlanRow | undefined {
		return this.get<EffectPlanRow>("SELECT * FROM effect_plans WHERE plan_id = ?", planId);
	}

	plans(status?: string): EffectPlanRow[] {
		return status
			? this.all<EffectPlanRow>("SELECT * FROM effect_plans WHERE status = ? ORDER BY created_at", status)
			: this.all<EffectPlanRow>("SELECT * FROM effect_plans ORDER BY created_at");
	}

	setPlanStatus(planId: string, status: EffectPlanRow["status"], detail: unknown): void {
		this.run("UPDATE effect_plans SET status = ?, updated_at = ? WHERE plan_id = ?", status, Date.now(), planId);
		this.audit(`effect_plan_${status}`, planId, detail);
	}

	journal(planId: string): JournalRow[] {
		return this.all<JournalRow>("SELECT * FROM effect_journal WHERE plan_id = ? ORDER BY op_index", planId);
	}

	journalEntry(key: string): JournalRow | undefined {
		return this.get<JournalRow>("SELECT * FROM effect_journal WHERE idempotency_key = ?", key);
	}

	/** Entries a crash may have left between prepare and commit. */
	pendingJournal(): JournalRow[] {
		return this.all<JournalRow>("SELECT * FROM effect_journal WHERE state = 'prepared' ORDER BY plan_id, op_index");
	}

	/**
	 * Durably record one effect's state. Each transition is also an audit record (invariant 8),
	 * so the chain holds the full history even though the journal row is updated in place.
	 */
	journalSet(planId: string, opIndex: number, key: string, state: JournalRow["state"], detail: unknown): void {
		this.run(
			`INSERT INTO effect_journal (idempotency_key, plan_id, op_index, state, detail_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(idempotency_key) DO UPDATE SET state = excluded.state, detail_json = excluded.detail_json, updated_at = excluded.updated_at`,
			key,
			planId,
			opIndex,
			state,
			canonical(detail),
			Date.now(),
		);
		this.audit(`effect_${state}`, planId, { op: opIndex, key, detail });
	}

	/* ----------------------------------------------------------------- library, compiled */

	putLibrarySkill(skill: LibrarySkill, report: unknown): string {
		const hash = librarySkillHash(skill, PRIMITIVE_LIBRARY_HASH);
		const result = this.run(
			"INSERT OR IGNORE INTO library_v1 (skill_hash, name, definition_json, report_json, created_at) VALUES (?, ?, ?, ?, ?)",
			hash,
			skill.name,
			canonical(skill),
			canonical(report),
			Date.now(),
		);
		if (Number(result.changes) > 0) this.audit("abstraction_added", hash, { name: skill.name, report });
		return hash;
	}

	library(): Map<string, LibrarySkill> {
		const rows = this.all<{ skill_hash: string; definition_json: string }>(
			"SELECT skill_hash, definition_json FROM library_v1 ORDER BY created_at",
		);
		return new Map(rows.map((row) => [row.skill_hash, JSON.parse(row.definition_json) as LibrarySkill]));
	}

	putCompiled(programHashValue: string, bytecodeHash: string, compilerVersion: number, report: unknown): void {
		this.run(
			"INSERT INTO compiled_v1 (program_hash, bytecode_hash, compiler_version, report_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(program_hash) DO UPDATE SET bytecode_hash = excluded.bytecode_hash, compiler_version = excluded.compiler_version, report_json = excluded.report_json",
			programHashValue,
			bytecodeHash,
			compilerVersion,
			canonical(report),
			Date.now(),
		);
		this.audit("compiled", programHashValue, { bytecode: bytecodeHash, report });
	}

	compiled(
		programHashValue: string,
	): { bytecode_hash: string; compiler_version: number; report_json: string } | undefined {
		return this.get(
			"SELECT bytecode_hash, compiler_version, report_json FROM compiled_v1 WHERE program_hash = ?",
			programHashValue,
		);
	}

	dropCompiled(programHashValue: string, reason: string): void {
		this.run("DELETE FROM compiled_v1 WHERE program_hash = ?", programHashValue);
		this.audit("compiled_dropped", programHashValue, { reason });
	}

	/* -------------------------------------------------------------------------- artifacts */

	artifactPath(hash: string): string {
		return join(this.dataDir, "artifacts", "sha256", hash.slice(0, 2), hash.slice(2, 4), hash);
	}

	/**
	 * Write bytes to a temporary file, verify the hash, move them into the content-addressed
	 * store, and only then insert the reference (section 44.3). A crash can leave unreferenced
	 * bytes, which garbage collection removes, but never a row pointing at missing bytes.
	 */
	putArtifact(bytes: Buffer, mime: string, producer: string, retention = "keep"): string {
		const hash = sha256(bytes);
		const path = this.artifactPath(hash);
		if (!existsSync(path)) {
			mkdirSync(dirname(path), { recursive: true });
			const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
			writeFileSync(temp, bytes, { flush: true });
			if (sha256(readFileSync(temp)) !== hash) {
				rmSync(temp, { force: true });
				throw new Error("artifact hash changed while writing");
			}
			renameSync(temp, path);
		}
		faultPoint("artifact-before-row");
		// `created_at` is refreshed on every reference, so retention ages bytes by their last use.
		this.run(
			"INSERT INTO artifacts (hash, mime, size, producer, retention, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET created_at = excluded.created_at",
			hash,
			mime,
			bytes.length,
			producer,
			retention,
			Date.now(),
		);
		return hash;
	}

	readArtifact(hash: string): Buffer {
		const bytes = readFileSync(this.artifactPath(hash));
		if (sha256(bytes) !== hash) throw new Error(`artifact ${hash.slice(0, 12)} is corrupt`);
		return bytes;
	}

	/**
	 * Retention (spec section 7.7): release episode inputs and reports not referenced for a while,
	 * old cache entries and expired facts. Episode rows keep the content hash, so provenance
	 * survives; the bytes go at the next garbage collection. Compiled artifacts, audit records,
	 * versions and counterexamples are never released here.
	 */
	applyRetention(policy: { episodeInputDays: number; reportDays: number; cacheDays: number }): {
		artifactsReleased: number;
		cacheRemoved: number;
		factsExpired: number;
	} {
		const day = 24 * 3600 * 1000;
		const now = Date.now();
		const released =
			Number(
				this.run(
					"DELETE FROM artifacts WHERE retention = 'episode' AND created_at < ?",
					now - policy.episodeInputDays * day,
				).changes,
			) +
			Number(
				this.run(
					"DELETE FROM artifacts WHERE retention = 'report' AND created_at < ?",
					now - policy.reportDays * day,
				).changes,
			);
		const cache = Number(this.run("DELETE FROM cache WHERE created_at < ?", now - policy.cacheDays * day).changes);
		const facts = Number(this.run("DELETE FROM facts WHERE expires_at IS NOT NULL AND expires_at <= ?", now).changes);
		const result = { artifactsReleased: released, cacheRemoved: cache, factsExpired: facts };
		this.audit("maintenance_retention", "store", { policy, ...result });
		return result;
	}

	/** Bytes of local state: the database plus every referenced artifact. */
	usageBytes(): number {
		const pages = this.get<{ page_count: number }>("PRAGMA page_count")?.page_count ?? 0;
		const size = this.get<{ page_size: number }>("PRAGMA page_size")?.page_size ?? 0;
		const artifacts = this.get<{ total: number | null }>("SELECT SUM(size) AS total FROM artifacts")?.total ?? 0;
		return pages * size + artifacts;
	}

	/** Integrity of a database file that is not open (restore validation). */
	static verifyFile(path: string, dataDir: string): IntegrityReport {
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			return verifyDatabase(db, dataDir);
		} finally {
			db.close();
		}
	}

	/**
	 * Mark and sweep (section 44.3): bytes are removed only when no row references them and they
	 * are older than the grace period.
	 */
	collectGarbage(graceMs = 24 * 3600 * 1000): { removed: number; kept: number } {
		const referenced = new Set(this.all<{ hash: string }>("SELECT hash FROM artifacts").map((row) => row.hash));
		const root = join(this.dataDir, "artifacts", "sha256");
		let removed = 0;
		let kept = 0;
		if (!existsSync(root)) return { removed, kept };
		for (const a of readdirSync(root)) {
			for (const b of readdirSync(join(root, a))) {
				for (const name of readdirSync(join(root, a, b))) {
					const path = join(root, a, b, name);
					const hash = name.replace(/\..*$/, "");
					const old = Date.now() - statSync(path).mtimeMs > graceMs;
					if ((!referenced.has(hash) || name.endsWith(".tmp")) && old) {
						rmSync(path, { force: true });
						removed++;
					} else kept++;
				}
			}
		}
		this.audit("maintenance_gc", "artifacts", { removed, kept });
		return { removed, kept };
	}

	/* ------------------------------------------------------------------ cache, bandit, ledger */

	cacheGet(key: string, versionId: number): unknown | undefined {
		const row = this.get<{ output_json: string }>(
			"SELECT output_json FROM cache WHERE key = ? AND version_id = ?",
			key,
			versionId,
		);
		return row ? (JSON.parse(row.output_json) as unknown) : undefined;
	}

	cachePut(key: string, versionId: number, output: unknown): void {
		this.run(
			"INSERT INTO cache (key, version_id, output_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET version_id = excluded.version_id, output_json = excluded.output_json, created_at = excluded.created_at",
			key,
			versionId,
			canonical(output),
			Date.now(),
		);
	}

	banditArms(prefix: string): { arm: string; trials: number; reward: number }[] {
		return this.all("SELECT arm, trials, reward FROM bandit WHERE arm LIKE ? ORDER BY arm", `${prefix}%`);
	}

	banditUpdate(arm: string, reward: number): void {
		this.run(
			"INSERT INTO bandit (arm, trials, reward) VALUES (?, 1, ?) ON CONFLICT(arm) DO UPDATE SET trials = trials + 1, reward = reward + excluded.reward",
			arm,
			reward,
		);
	}

	ledgerReserve(day: string, reservedMs: number): string {
		const id = newId("res");
		this.run(
			"INSERT INTO ledger (reservation_id, day, reserved_ms, consumed_ms, state, created_at) VALUES (?, ?, ?, NULL, 'reserved', ?)",
			id,
			day,
			reservedMs,
			Date.now(),
		);
		return id;
	}

	ledgerReconcile(reservationId: string, consumedMs: number): void {
		this.run(
			"UPDATE ledger SET consumed_ms = ?, state = 'reconciled' WHERE reservation_id = ? AND state = 'reserved'",
			consumedMs,
			reservationId,
		);
	}

	/** CPU ms charged today: reconciled usage plus the full amount of open reservations (a crash is charged). */
	ledgerCharged(day: string): number {
		return (
			this.get<{ total: number | null }>(
				"SELECT SUM(CASE WHEN state = 'reserved' THEN reserved_ms ELSE consumed_ms END) AS total FROM ledger WHERE day = ?",
				day,
			)?.total ?? 0
		);
	}

	/* --------------------------------------------------------------------------- snapshots */

	/**
	 * Snapshot with `VACUUM INTO`, SQLite's supported way to copy a live WAL database consistently
	 * (section 44.4), plus a manifest of hashes (section 15.2).
	 */
	createSnapshot(policyHash: string): { snapshotId: string; path: string; manifest: SnapshotManifest } {
		const snapshotId = newId("snap");
		const dir = join(this.dataDir, "snapshots", snapshotId);
		mkdirSync(dir, { recursive: true });
		const dbPath = join(dir, "lattice.db");
		this.db.prepare("VACUUM INTO ?").run(dbPath);
		const activeVersions: { [skillId: string]: number } = {};
		for (const row of this.skills()) activeVersions[row.skill_id] = row.version_id;
		const manifest: SnapshotManifest = {
			snapshot_id: snapshotId,
			created_at: new Date().toISOString(),
			kernel_version: KERNEL_VERSION,
			database_sha256: sha256(readFileSync(dbPath)),
			active_versions: activeVersions,
			primitive_library_sha256: PRIMITIVE_LIBRARY_HASH,
			policy_sha256: policyHash,
			audit_root: this.auditRoot(),
			artifacts: this.all<{ hash: string }>("SELECT hash FROM artifacts ORDER BY hash").map((row) => row.hash),
		};
		faultPoint("snapshot-before-manifest");
		writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		this.audit("snapshot_created", snapshotId, {
			database_sha256: manifest.database_sha256,
			audit_root: manifest.audit_root,
		});
		return { snapshotId, path: dir, manifest };
	}

	listSnapshots(): SnapshotManifest[] {
		const root = join(this.dataDir, "snapshots");
		if (!existsSync(root)) return [];
		return readdirSync(root)
			.filter((name) => existsSync(join(root, name, "manifest.json")))
			.map((name) => JSON.parse(readFileSync(join(root, name, "manifest.json"), "utf8")) as SnapshotManifest)
			.sort((a, b) => a.created_at.localeCompare(b.created_at));
	}

	/** Restore validation: the snapshot's database hash, integrity and artifact presence. */
	verifySnapshot(snapshotId: string): IntegrityReport {
		const dir = join(this.dataDir, "snapshots", snapshotId);
		const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as SnapshotManifest;
		const dbPath = join(dir, "lattice.db");
		const problems: string[] = [];
		if (sha256(readFileSync(dbPath)) !== manifest.database_sha256) problems.push("snapshot database hash mismatch");
		const snapshot = new DatabaseSync(dbPath, { readOnly: true });
		let report: IntegrityReport;
		try {
			report = verifyDatabase(snapshot, this.dataDir);
		} finally {
			snapshot.close();
		}
		for (const hash of manifest.artifacts)
			if (!existsSync(this.artifactPath(hash))) problems.push(`missing artifact ${hash.slice(0, 12)}`);
		const all = [...problems, ...report.problems];
		return {
			ok: all.length === 0,
			problems: all,
			corruptHeads: report.corruptHeads,
			auditBrokenAt: report.auditBrokenAt,
		};
	}

	stats(): { [table: string]: number } {
		const out: { [table: string]: number } = {};
		for (const table of [
			"versions_v1",
			"programs_v1",
			"episodes",
			"regressions",
			"library_v1",
			"compiled_v1",
			"audit",
			"consumed_releases_v1",
			"campaigns",
		]) {
			out[table] = this.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;
		}
		return out;
	}
}

export interface EffectPlanRow {
	plan_id: string;
	episode_id: string;
	skill_id: string;
	version_id: number;
	root: string;
	plan_hash: string;
	intents_json: string;
	status: "proposed" | "applying" | "applied" | "partial" | "compensated" | "unresolved" | "expired";
	expires_at: number;
	created_at: number;
	updated_at: number;
}

export interface JournalRow {
	idempotency_key: string;
	plan_id: string;
	op_index: number;
	state: "prepared" | "committed" | "failed" | "unperformed" | "compensated" | "unresolved";
	detail_json: string;
	updated_at: number;
}

export interface SnapshotManifest {
	snapshot_id: string;
	created_at: string;
	kernel_version: string;
	database_sha256: string;
	active_versions: { [skillId: string]: number };
	primitive_library_sha256: string;
	policy_sha256: string;
	audit_root: string;
	artifacts: string[];
}

/** Signal 0 checks existence only; EPERM means the process exists under another user. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function recomputeHash(row: { kind: string; canonical_ir: string; primitives_hash: string }): string | undefined {
	try {
		const parsed = JSON.parse(row.canonical_ir) as unknown;
		return row.kind === "policy" ? digest(parsed) : programHash(parsed as Program, row.primitives_hash);
	} catch {
		return undefined;
	}
}

/**
 * Integrity checks (spec sections 19.3 and 20.4): the audit chain, every stored program against
 * its hash, active heads against stored versions, library entries and compiled artifacts.
 * A hash chain detects accidental and naive edits; it does not authenticate history against
 * someone who can rewrite every record (section 44.5).
 */
function verifyDatabase(db: DatabaseSync, dataDir: string): IntegrityReport {
	const problems: string[] = [];
	let auditBrokenAt: number | undefined;
	let previous = GENESIS;
	for (const row of db
		.prepare("SELECT seq, kind, subject, payload, created_at, previous, digest FROM audit ORDER BY seq")
		.all() as {
		seq: number;
		kind: string;
		subject: string;
		payload: string;
		created_at: number;
		previous: string;
		digest: string;
	}[]) {
		if (
			row.previous !== previous ||
			digest([previous, row.created_at, row.kind, row.subject, row.payload]) !== row.digest
		) {
			auditBrokenAt = row.seq;
			problems.push(`audit chain broken at record ${row.seq}`);
			break;
		}
		previous = row.digest;
	}
	const badPrograms = new Set<string>();
	for (const row of db.prepare("SELECT program_hash, kind, canonical_ir, primitives_hash FROM programs_v1").all() as {
		program_hash: string;
		kind: string;
		canonical_ir: string;
		primitives_hash: string;
	}[]) {
		if (recomputeHash(row) !== row.program_hash) {
			badPrograms.add(row.program_hash);
			// Recovery quarantines a corrupt program by marking every version that uses it invalid.
			const live = db
				.prepare("SELECT 1 FROM versions_v1 WHERE program_hash = ? AND status != 'invalid' LIMIT 1")
				.get(row.program_hash);
			const used = db.prepare("SELECT 1 FROM versions_v1 WHERE program_hash = ? LIMIT 1").get(row.program_hash);
			if (live || !used) problems.push(`program ${row.program_hash.slice(0, 12)} does not match its hash`);
		}
	}
	const corruptHeads: string[] = [];
	for (const row of db
		.prepare(
			"SELECT h.skill_id, h.version_id, v.program_hash FROM active_heads_v1 h LEFT JOIN versions_v1 v ON v.version_id = h.version_id AND v.skill_id = h.skill_id",
		)
		.all() as { skill_id: string; version_id: number; program_hash: string | null }[]) {
		if (row.program_hash === null) problems.push(`head of ${row.skill_id} points to a missing version`);
		else if (badPrograms.has(row.program_hash)) corruptHeads.push(row.skill_id);
	}
	for (const row of db.prepare("SELECT skill_hash, definition_json FROM library_v1").all() as {
		skill_hash: string;
		definition_json: string;
	}[]) {
		try {
			if (
				librarySkillHash(JSON.parse(row.definition_json) as LibrarySkill, PRIMITIVE_LIBRARY_HASH) !== row.skill_hash
			) {
				problems.push(`library skill ${row.skill_hash.slice(0, 12)} does not match its hash`);
			}
		} catch {
			problems.push(`library skill ${row.skill_hash.slice(0, 12)} is unreadable`);
		}
	}
	for (const row of db.prepare("SELECT bytecode_hash FROM compiled_v1").all() as { bytecode_hash: string }[]) {
		const path = join(
			dataDir,
			"artifacts",
			"sha256",
			row.bytecode_hash.slice(0, 2),
			row.bytecode_hash.slice(2, 4),
			row.bytecode_hash,
		);
		if (!existsSync(path) || sha256(readFileSync(path)) !== row.bytecode_hash) {
			problems.push(`compiled artifact ${row.bytecode_hash.slice(0, 12)} missing or corrupt`);
		}
	}
	return { ok: problems.length === 0, problems, auditBrokenAt, corruptHeads };
}
