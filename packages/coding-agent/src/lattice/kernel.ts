import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AbstractionReport, mineAbstractions } from "./abstraction.ts";
import { type AdapterOutput, type GoalAdapter, templateAdapter } from "./adapter.ts";
import {
	type ContentHashHost,
	contentHashHost,
	type InventorySnapshot,
	issueCapability,
	scanDirectory,
} from "./broker.ts";
import { type CampaignReport, type KernelContext, runCampaign } from "./campaign.ts";
import { canonical, digest } from "./canonical.ts";
import {
	type Bytecode,
	bytecodeHash,
	COMPILER_VERSION,
	compileProgram,
	differential,
	runBytecode,
	verifyBytecode,
} from "./compile.ts";
import {
	CONTRACTS,
	type Contract,
	getContract,
	INVENTORY_MAX_ENTRIES,
	RECORD_BASELINE,
	recordBoundaryFixture,
	recordsFilter,
	recordsFilterProgram,
} from "./contracts.ts";
import {
	type ApplyReport,
	applyPlan,
	buildPlan,
	type CompensationReport,
	compensatePlan,
	type EffectHooks,
	type ReconcileEntry,
	reconcileEffects,
} from "./effects.ts";
import { evaluateSuite } from "./evaluator.ts";
import { Governor, ucbSelect } from "./governor.ts";
import { installHarnessPolicy } from "./harness-policy.ts";
import { interpret, type RunResult } from "./interpreter.ts";
import { type LibrarySkill, type Program, programHash, T, type Value } from "./ir.ts";
import { BUDGETS, type ExecutionLimits, INSTALLATION_LIMITS, RETENTION, STATE_QUOTA_BYTES } from "./limits.ts";
import {
	improvePolicy,
	META_CONTRACT,
	POLICY_SKILL,
	type PolicyCampaignReport,
	policyEvaluatorHash,
} from "./metapolicy.ts";
import { defaultDataDir } from "./paths.ts";
import { type Host, LatticeError, PRIMITIVE_LIBRARY_HASH } from "./primitives.ts";
import { DEFAULT_POLICY, REFERENCE_POLICY, type SearchPolicy } from "./search.ts";
import { KERNEL_VERSION, LatticeStore, newId } from "./store.ts";
import { type ExampleTask, type SynthesisResult, synthesize } from "./synthesis.ts";
import { checkProgram, validateValue } from "./typecheck.ts";

/**
 * The Lattice-1 kernel (spec sections 2, 4, 5). It owns the store, the active-version pointers,
 * the capability key and the evaluator; candidates are data it checks and runs. The hot path
 * uses the cheapest verified procedure (exact cache, then the active skill, interpreted or
 * compiled) and never starts a search. Improvement is a separate, explicit, budgeted campaign.
 */
export const CANARY_RUNS = 5;

export interface GoalRequest {
	contract_id?: string;
	skill_id?: string;
	/** Structured input for the contract. */
	input?: unknown;
	/** Directory for inventory or organize goals; the broker scans it read-only. */
	directory?: string;
	/** Free text for the optional adapter. */
	text?: string;
	constraints?: { network?: "deny" | "allow"; max_runtime_ms?: number };
}

export interface GoalResult {
	goal_id: string;
	status: "completed" | "awaiting_approval" | "failed" | "needs_clarification" | "declined";
	summary: { [key: string]: unknown };
	evidence: string[];
	skill_used?: { skill_id: string; version: number; engine: "interpreter" | "bytecode" | "cache" };
	runtime_ms: number;
	output?: unknown;
	artifact?: string;
	questions?: string[];
	error?: string;
	adapter?: AdapterOutput;
	/** Why the goal did not complete (spec section 19.1); absent when it completed. */
	failure_class?: FailureClass;
	/** For effect contracts: the proposed plan. Nothing changes until `applyPlan(plan_id)`. */
	plan?: { plan_id: string; plan_hash: string; moves: number; expires_at: string };
}

/**
 * Failure classes (spec section 19.1), plus `invalid_input` for input that is well specified but
 * outside the contract's schema or bounds.
 */
export type FailureClass =
	| "input_ambiguity"
	| "invalid_input"
	| "missing_capability"
	| "permission_denial"
	| "deterministic_skill_bug"
	| "resource_exhaustion"
	| "external_dependency_failure";

/** Class of a runtime error raised while a skill ran. */
function runFailureClass(code: string): FailureClass {
	if (code === "fuel" || code === "steps" || code === "bound" || code === "deadline") return "resource_exhaustion";
	if (code === "effect") return "permission_denial";
	if (code === "host") return "external_dependency_failure";
	return "deterministic_skill_bug";
}

/** Contracts whose input is a directory inventory observed by the broker. */
const DIRECTORY_CONTRACTS = new Set(["inventory.report", "organize.plan", "duplicates.report"]);
export { defaultDataDir };

/** Contracts whose output is a list of effect intents. */
const EFFECT_CONTRACTS = new Set(["organize.plan"]);

export class Lattice implements KernelContext {
	readonly store: LatticeStore;
	readonly governor: Governor;
	readonly limits: ExecutionLimits = INSTALLATION_LIMITS;
	/** Optional; the kernel keeps working with `undefined` (structured goals only). */
	adapter: GoalAdapter | undefined;
	private libraryCache: Map<string, LibrarySkill> | undefined;
	/** Effects a crash had left half-done, resolved when the store was opened. */
	readonly recovered: ReconcileEntry[];
	/** Campaigns a dead process had left running, resolved when the store was opened. */
	readonly interruptedCampaigns: ReturnType<LatticeStore["reconcileCampaigns"]>;

	private constructor(store: LatticeStore, adapter: GoalAdapter | undefined) {
		this.store = store;
		this.governor = new Governor(store);
		this.adapter = adapter;
		// Startup recovery (section 19.3): interrupted effects and campaigns are reconciled before any new work.
		this.recovered = reconcileEffects(store);
		this.interruptedCampaigns = store.reconcileCampaigns();
	}

	static open(
		dataDir = defaultDataDir(),
		options: { adapter?: GoalAdapter | null; memory?: boolean; quotaBytes?: number } = {},
	): Lattice {
		const store = options.memory ? LatticeStore.memory(dataDir) : LatticeStore.open(dataDir);
		const lattice = new Lattice(store, options.adapter === null ? undefined : (options.adapter ?? templateAdapter));
		if (options.quotaBytes !== undefined) lattice.quotaBytes = options.quotaBytes;
		return lattice;
	}

	/**
	 * Restore a snapshot (spec section 44.4): validate the snapshot (database hash, integrity,
	 * artifacts), copy it next to the live database, validate the copy, and only then move the
	 * current database aside (kept under `pre-restore-*`) and put the copy in its place. The
	 * restore itself is appended to the restored audit chain. The store must not be open.
	 */
	static restore(dataDir: string, snapshotId: string): { restored: string; previous: string } {
		const current = LatticeStore.open(dataDir);
		let check: ReturnType<LatticeStore["verifySnapshot"]>;
		try {
			check = current.verifySnapshot(snapshotId);
		} finally {
			current.close();
		}
		if (!check.ok) throw new Error(`snapshot ${snapshotId} failed validation: ${check.problems.join("; ")}`);
		const live = join(dataDir, "lattice.db");
		const staged = join(dataDir, "lattice.db.restoring");
		copyFileSync(join(dataDir, "snapshots", snapshotId, "lattice.db"), staged);
		const staging = LatticeStore.verifyFile(staged, dataDir);
		if (!staging.ok) {
			rmSync(staged, { force: true });
			throw new Error(`restored copy failed validation: ${staging.problems.join("; ")}`);
		}
		const previous = join(dataDir, `pre-restore-${Date.now()}`);
		mkdirSync(previous);
		for (const suffix of ["", "-wal", "-shm"]) {
			if (existsSync(live + suffix)) renameSync(live + suffix, join(previous, `lattice.db${suffix}`));
		}
		renameSync(staged, live);
		const store = LatticeStore.open(dataDir);
		try {
			store.audit("restored", snapshotId, { previous_database: previous });
		} finally {
			store.close();
		}
		return { restored: snapshotId, previous };
	}

	/** Local state quota (spec section 42.1). */
	quotaBytes = STATE_QUOTA_BYTES;

	quota(): { usedBytes: number; limitBytes: number; state: "ok" | "near" | "full" } {
		const usedBytes = this.store.usageBytes();
		const state = usedBytes >= this.quotaBytes ? "full" : usedBytes >= this.quotaBytes * 0.9 ? "near" : "ok";
		return { usedBytes, limitBytes: this.quotaBytes, state };
	}

	/** Backpressure before exhaustion: new work is refused, with the reason, once the quota is reached. */
	private quotaRefusal(): string | undefined {
		const quota = this.quota();
		if (quota.state !== "full") return undefined;
		const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
		return `storage quota reached (${mib(quota.usedBytes)} of ${mib(quota.limitBytes)} MiB); run \`lattice maintenance\``;
	}

	close(): void {
		this.store.close();
	}

	/**
	 * First install (spec section 29.1): register contracts and their evaluators, install the
	 * signed seed programs and the seed search policy, create the capability key, run the kernel
	 * self-checks and take the seed snapshot.
	 */
	init(options: { snapshot?: boolean } = {}): { skills: string[]; snapshot?: string } {
		for (const contract of CONTRACTS.values()) {
			this.store.ensureContract(contract);
			this.store.installSeed(contract.id, contract, contract.seed());
		}
		this.store.ensureContractRow(META_CONTRACT.id, META_CONTRACT.revision, policyEvaluatorHash());
		this.store.installSeed(POLICY_SKILL, META_CONTRACT, DEFAULT_POLICY, "policy");
		// The harness policy (harness/policy.ts): the seed is the built-in defaults, exported for the harness.
		installHarnessPolicy(this.store);
		if (!this.store.getMeta("capability_key")) this.store.setMeta("capability_key", randomBytes(32).toString("hex"));
		quickSelfCheck();
		const skills = this.store.skills().map((row) => row.skill_id);
		if (options.snapshot === false || this.store.listSnapshots().length > 0) return { skills };
		return { skills, snapshot: this.store.createSnapshot(this.policy().hash).snapshotId };
	}

	library(): Map<string, LibrarySkill> {
		this.libraryCache ??= this.store.library();
		return this.libraryCache;
	}

	policy(): { record: SearchPolicy; hash: string; version: number } {
		const head = this.store.headRecord<SearchPolicy>(POLICY_SKILL);
		if (!head) throw new Error("not initialized: run `lattice init`");
		return { record: head.record, hash: head.version.program_hash, version: head.version.version_id };
	}

	/** Recent distinct, valid inputs of completed episodes, newest first. */
	episodeInputs(contract: Contract, limit: number): Value[] {
		if (contract.granted.includes("read")) return this.rescanEpisodes(contract, limit);
		const out: Value[] = [];
		const seen = new Set<string>();
		for (const episode of this.store.episodes(contract.id, limit * 4)) {
			if (episode.status !== "completed" || seen.has(episode.input_hash)) continue;
			seen.add(episode.input_hash);
			try {
				out.push(contract.validateInput(JSON.parse(this.store.readArtifact(episode.input_hash).toString("utf8"))));
			} catch {
				// Missing or corrupt input bytes: skip rather than trust them.
			}
			if (out.length >= limit) break;
		}
		return out;
	}

	/** Broker hosts of the latest rescan, by input digest. */
	private readonly liveHosts = new Map<string, Host>();

	hostFor(contract: Contract): ((input: Value) => Host) | undefined {
		const synthetic = contract.host?.bind(contract);
		if (!contract.granted.includes("read")) return synthetic;
		return (input) => this.liveHosts.get(digest(input)) ?? synthetic?.(input) ?? {};
	}

	/**
	 * Live inputs of a contract that reads file contents. The store keeps inventories, never file
	 * bytes, so an old inventory cannot be replayed against the contents it described. Each
	 * episode's directory is scanned again under a fresh capability and its input is paired with a
	 * broker host; a directory that is gone, unreadable or now too large is skipped.
	 */
	private rescanEpisodes(contract: Contract, limit: number): Value[] {
		this.liveHosts.clear();
		const out: Value[] = [];
		const seen = new Set<string>();
		for (const episode of this.store.episodes(contract.id, limit * 4)) {
			const directory = (JSON.parse(episode.goal_json) as { directory?: string }).directory;
			if (episode.status !== "completed" || directory === undefined || seen.has(directory)) continue;
			seen.add(directory);
			try {
				const { snapshot, host } = this.observe(contract, directory, newId("replay"));
				const input = contract.validateInput(snapshot.entries);
				if (host) this.liveHosts.set(digest(input), host);
				out.push(input);
			} catch {
				// Nothing to replay from this directory now.
			}
			if (out.length >= limit) break;
		}
		return out;
	}

	/** Scan a directory read-only; contracts that read contents also get a content host for it. */
	private observe(
		contract: Contract,
		directory: string,
		episodeId: string,
	): { snapshot: InventorySnapshot; host?: ContentHashHost } {
		const key = this.capabilityKey();
		const reads = contract.granted.includes("read");
		const capability = issueCapability(key, {
			root: directory,
			verbs: reads ? ["list", "read"] : ["list"],
			episodeId,
		});
		const snapshot = scanDirectory(key, capability, episodeId, INVENTORY_MAX_ENTRIES);
		return { snapshot, host: reads ? contentHashHost(key, capability, episodeId, snapshot.identities) : undefined };
	}

	private capabilityKey(): string {
		const key = this.store.getMeta("capability_key");
		if (!key) throw new Error("not initialized: run `lattice init`");
		return key;
	}

	/* ------------------------------------------------------------------------ hot path */

	async submitGoal(request: GoalRequest): Promise<GoalResult> {
		const started = performance.now();
		const goalId = newId("ep");
		const done = (result: Omit<GoalResult, "goal_id" | "runtime_ms">): GoalResult => ({
			goal_id: goalId,
			runtime_ms: Math.round((performance.now() - started) * 1000) / 1000,
			// Defaults by status; sites with a more specific cause set it themselves.
			failure_class:
				result.status === "needs_clarification"
					? "input_ambiguity"
					: result.status === "declined"
						? "missing_capability"
						: undefined,
			...result,
		});
		let adapterOutput: AdapterOutput | undefined;
		let req = request;
		if (!req.contract_id && !req.skill_id && req.text !== undefined) {
			if (!this.adapter) {
				return done({
					status: "needs_clarification",
					summary: {},
					evidence: [],
					questions: ["no goal adapter is installed; pass a contract and input"],
				});
			}
			adapterOutput = this.adapter.propose(req.text);
			if (adapterOutput.uncertainties.length > 0) {
				return done({
					status: "needs_clarification",
					summary: {},
					evidence: [],
					questions: adapterOutput.uncertainties,
					adapter: adapterOutput,
				});
			}
			req = { ...req, contract_id: adapterOutput.goal.contract_id, directory: adapterOutput.goal.directory };
			if (adapterOutput.goal.input_file !== undefined) {
				return done({
					status: "needs_clarification",
					summary: {},
					evidence: [],
					questions: [
						`pass the file explicitly: lattice goal --contract ${adapterOutput.goal.contract_id} --input ${adapterOutput.goal.input_file}`,
					],
					adapter: adapterOutput,
				});
			}
		}
		const refusal = this.quotaRefusal();
		if (refusal)
			return done({ status: "declined", summary: {}, evidence: [refusal], failure_class: "resource_exhaustion" });
		if (req.constraints?.network === "allow") {
			return done({
				status: "declined",
				summary: {},
				evidence: ["no network capability exists in this installation"],
			});
		}
		const skillId = req.skill_id ?? req.contract_id;
		if (!skillId)
			return done({
				status: "needs_clarification",
				summary: {},
				evidence: [],
				questions: ["which contract or skill?"],
			});
		const head = this.store.head(skillId);
		if (!head)
			return done({ status: "declined", summary: {}, evidence: [`no skill ${skillId}; run \`lattice init\``] });
		let contract: Contract;
		try {
			contract = getContract(head.version.contract_id);
		} catch (error) {
			return done({ status: "declined", summary: {}, evidence: [(error as Error).message] });
		}

		// Inputs: structured, or observed through a read-only capability.
		const evidence: string[] = [];
		let raw = req.input;
		let observed: InventorySnapshot | undefined;
		let host: ContentHashHost | undefined;
		const reads = contract.granted.includes("read");
		if (reads && req.directory === undefined) {
			return done({
				status: "needs_clarification",
				summary: {},
				evidence: [],
				questions: [`${contract.id} reads file contents: which directory?`],
			});
		}
		if (req.directory !== undefined) {
			if (!DIRECTORY_CONTRACTS.has(contract.id)) {
				return done({ status: "declined", summary: {}, evidence: [`${contract.id} does not take a directory`] });
			}
			try {
				const observation = this.observe(contract, req.directory, goalId);
				const snapshot = observation.snapshot;
				host = observation.host;
				raw = snapshot.entries;
				observed = snapshot;
				// Episodes record the resolved root, so a later rescan finds the same directory.
				req = { ...req, directory: snapshot.root };
				evidence.push(`${snapshot.mode} of ${snapshot.root} at ${snapshot.observed_at}`);
				if (snapshot.skipped.length > 0) {
					evidence.push(
						`${snapshot.skipped.length} paths not inventoried: ${snapshot.skipped
							.slice(0, 5)
							.map((entry) => `${entry.path} (${entry.reason})`)
							.join(", ")}`,
					);
				}
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code ?? (error as { code?: string }).code;
				return done({
					status: "failed",
					summary: {},
					evidence,
					error: (error as Error).message,
					failure_class:
						code === "EACCES" || code === "EPERM" || code === "effect"
							? "permission_denial"
							: code === "bound"
								? "resource_exhaustion"
								: code === "ENOENT" || code === "ENOTDIR"
									? "invalid_input"
									: "external_dependency_failure",
				});
			}
		}
		if (raw === undefined)
			return done({ status: "needs_clarification", summary: {}, evidence, questions: ["no input given"] });
		let input: Value;
		try {
			input = contract.validateInput(raw);
		} catch (error) {
			return done({
				status: "failed",
				summary: {},
				evidence,
				error: `invalid input: ${(error as Error).message}`,
				failure_class: "invalid_input",
			});
		}
		const inputHash = this.store.putArtifact(
			Buffer.from(canonical(input)),
			"application/json",
			`episode:${goalId}`,
			"episode",
		);
		const version = head.version.version_id;
		const cacheKey = digest({ skill: skillId, version, input: inputHash });
		const plan: { tier: string; engine?: string; skill: string; version: number } = {
			tier: "exact-cache",
			skill: skillId,
			version,
		};
		const wallMs = contract.budgetMs ?? BUDGETS.interactive.wallMs;
		const deadline = performance.now() + Math.min(req.constraints?.max_runtime_ms ?? wallMs, wallMs);

		let output: Value | undefined;
		let engine: "interpreter" | "bytecode" | "cache" = "cache";
		let units: number | undefined;
		// The cache key covers the inventory, not file contents, so it cannot answer a content question.
		const cached = reads ? undefined : this.store.cacheGet(cacheKey, version);
		if (cached !== undefined) {
			output = cached as Value;
			evidence.push(`exact cache hit for version ${version}`);
		} else {
			plan.tier = "active-skill";
			const compiled = this.loadCompiled(head.program);
			const arms = compiled ? ["interpreter", "bytecode"] : ["interpreter"];
			const stats = new Map(
				this.store
					.banditArms(`engine:${head.version.program_hash}:`)
					.map((row) => [row.arm.split(":").pop()!, row]),
			);
			engine = ucbSelect(arms, stats) as "interpreter" | "bytecode";
			plan.engine = engine;
			const runStarted = performance.now();
			const run: RunResult =
				engine === "bytecode" && compiled
					? runBytecode(compiled, input, { limits: this.limits, library: this.library(), deadline, host })
					: interpret(head.program, input, { limits: this.limits, library: this.library(), deadline, host });
			const elapsed = performance.now() - runStarted;
			this.store.banditUpdate(`engine:${head.version.program_hash}:${engine}`, 1 / (1 + elapsed));
			if (!run.ok) {
				this.recordEpisode(
					goalId,
					contract,
					skillId,
					version,
					req,
					inputHash,
					plan,
					{ error: run.error },
					{ passed: false },
					"failed",
					started,
				);
				// A file that changed under the run is the world's failure, not the canary's.
				if (head.version.status === "canary" && run.error.code !== "host") {
					// The parent is restored as champion, so this retry runs it and cannot recurse again.
					this.store.rollback(skillId, `canary failed on a live task: ${run.error.code}`);
					return this.submitGoal(request);
				}
				return done({
					status: "failed",
					summary: {},
					evidence,
					skill_used: { skill_id: skillId, version, engine },
					error: `${run.error.code}: ${run.error.message}`,
					failure_class: runFailureClass(run.error.code),
				});
			}
			output = run.value;
			units = run.metrics.units;
		}
		if (host) {
			const { files, bytes, cacheHits } = host.observed;
			evidence.push(
				`exact content: ${files} files hashed by streaming SHA-256 (${bytes} bytes; ${cacheHits} repeated hashes reused), each checked against its inventory identity before and after reading`,
			);
		}

		// Verify: output schema and every postcondition. The oracle is evaluation-time only.
		const failures: string[] = [];
		try {
			validateValue(contract.outputType, output, this.limits);
		} catch (error) {
			failures.push(`output schema: ${(error as Error).message}`);
		}
		for (const post of contract.postconditions) {
			if (!failures.length && !post.check(input, output)) failures.push(post.name);
		}
		if (failures.length === 0)
			evidence.push(`postconditions passed: ${contract.postconditions.map((post) => post.name).join(", ")}`);

		// Canary monitoring: shadow the parent; a disagreement is adjudicated by the oracle.
		let canary: unknown;
		let rolledBack = false;
		if (head.version.status === "canary" && head.version.parent_version !== null && engine !== "cache") {
			canary = this.monitorCanary(
				skillId,
				head.version.version_id,
				head.version.parent_version,
				contract,
				input,
				output,
				failures,
				host,
			);
			if ((canary as { rolledBack?: boolean }).rolledBack) {
				rolledBack = true;
				const parentOutput = (canary as { parentOutput?: Value }).parentOutput;
				if (parentOutput !== undefined) {
					output = parentOutput;
					failures.length = 0;
					evidence.push(
						`canary ${version} rolled back; result produced by version ${head.version.parent_version}`,
					);
				}
			}
		}
		if (failures.length > 0) {
			this.recordEpisode(
				goalId,
				contract,
				skillId,
				version,
				req,
				inputHash,
				plan,
				{ failures },
				{ passed: false, canary },
				"failed",
				started,
			);
			return done({
				status: "failed",
				summary: {},
				evidence,
				skill_used: { skill_id: skillId, version, engine },
				error: `verification failed: ${failures.join("; ")}`,
				failure_class: "deterministic_skill_bug",
			});
		}

		const outputBytes = Buffer.from(`${JSON.stringify(output, null, 2)}\n`);
		const artifact = this.store.putArtifact(outputBytes, "application/json", `${skillId}@${version}`, "report");
		if (engine !== "cache" && !rolledBack && !reads) this.store.cachePut(cacheKey, version, output);
		const summary = summarize(contract, input, output, units);
		const active = this.store.head(skillId)!.version.version_id;
		// Effect intents over an observed directory become a plan awaiting explicit approval.
		let proposed: GoalResult["plan"];
		if (EFFECT_CONTRACTS.has(contract.id) && observed) {
			const { row } = buildPlan({
				planId: newId("plan"),
				episodeId: goalId,
				skillId,
				versionId: active,
				root: observed.root,
				moves: output as unknown as { from: string; to: string }[],
				identities: observed.identities,
			});
			this.store.createPlan(row);
			proposed = {
				plan_id: row.plan_id,
				plan_hash: row.plan_hash,
				moves: (output as Value[]).length,
				expires_at: new Date(row.expires_at).toISOString(),
			};
			summary.plan_id = row.plan_id;
			evidence.push(`plan ${row.plan_id} proposed; nothing was changed. Apply it to approve exactly these moves.`);
		}
		this.recordEpisode(
			goalId,
			contract,
			skillId,
			active,
			req,
			inputHash,
			plan,
			summary,
			{ passed: true, evidence, canary },
			"completed",
			started,
		);
		return done({
			status: proposed ? "awaiting_approval" : "completed",
			summary,
			evidence,
			skill_used: { skill_id: skillId, version, engine },
			output,
			artifact: this.store.artifactPath(artifact),
			adapter: adapterOutput,
			plan: proposed,
		});
	}

	/** Approve and apply one proposed plan. The capability is bound to the plan's root and episode. */
	applyPlan(planId: string, hooks?: EffectHooks): ApplyReport {
		const plan = this.store.plan(planId);
		if (!plan) throw new Error(`no plan ${planId}`);
		const capability = issueCapability(this.capabilityKey(), {
			root: plan.root,
			verbs: ["list", "rename"],
			episodeId: plan.episode_id,
		});
		return applyPlan(this.store, this.capabilityKey(), capability, planId, hooks);
	}

	/** Undo the committed moves of a plan where the files are exactly as the plan left them. */
	undoPlan(planId: string): CompensationReport {
		const plan = this.store.plan(planId);
		if (!plan) throw new Error(`no plan ${planId}`);
		const capability = issueCapability(this.capabilityKey(), {
			root: plan.root,
			verbs: ["rename"],
			episodeId: plan.episode_id,
		});
		return compensatePlan(this.store, this.capabilityKey(), capability, planId);
	}

	plans(): unknown[] {
		return this.store.plans().map((plan) => ({
			plan_id: plan.plan_id,
			status: plan.status,
			skill: `${plan.skill_id}@${plan.version_id}`,
			root: plan.root,
			moves: (JSON.parse(plan.intents_json) as unknown[]).length,
			journal: this.store.journal(plan.plan_id).map((row) => ({ op: row.op_index, state: row.state })),
		}));
	}

	private monitorCanary(
		skillId: string,
		versionId: number,
		parentId: number,
		contract: Contract,
		input: Value,
		output: Value,
		failures: string[],
		host: Host | undefined,
	): { agree: number; rolledBack?: boolean; champion?: boolean; parentOutput?: Value } {
		const parent = this.store.version(parentId)!;
		const parentProgram = JSON.parse(this.store.programText(parent.program_hash)!) as Program;
		const shadow = interpret(parentProgram, input, { limits: this.limits, library: this.library(), host });
		const agrees = shadow.ok && canonical(shadow.value) === canonical(output) && failures.length === 0;
		const key = `canary:${versionId}`;
		const count = Number(this.store.getMeta(key) ?? "0");
		if (!agrees) {
			let oracle: Value;
			try {
				oracle = contract.oracle(input, host);
			} catch (error) {
				if (!(error instanceof LatticeError)) throw error;
				// The files changed under the oracle: neither version can be judged on this task.
				this.store.audit("canary_disagreement", skillId, {
					version: versionId,
					verdict: `not adjudicated: ${error.message}`,
				});
				return { agree: count };
			}
			const candidateRight = failures.length === 0 && canonical(oracle) === canonical(output);
			if (!candidateRight) {
				this.store.rollback(
					skillId,
					"canary disagreed with its parent on a live task and the oracle rejected the canary",
				);
				const parentRight = shadow.ok && canonical(shadow.value) === canonical(oracle);
				// The input becomes a regression case against the canary that failed it, unless the failure
				// depended on file contents, which a stored inventory cannot reproduce.
				if (!contract.granted.includes("read")) {
					this.store.addRegression(
						contract,
						input,
						"canary disagreement",
						this.store.version(versionId)!.program_hash,
					);
				}
				// The parent's answer replaces the canary's only when the oracle confirms it.
				return { agree: count, rolledBack: true, parentOutput: parentRight ? shadow.value : undefined };
			}
			this.store.audit("canary_disagreement", skillId, {
				version: versionId,
				verdict: "candidate matched the oracle",
			});
		}
		const next = count + 1;
		this.store.setMeta(key, String(next));
		if (next >= CANARY_RUNS) {
			this.store.confirmChampion(skillId, versionId, { live_runs: next, rule: `${CANARY_RUNS} agreeing live runs` });
			return { agree: next, champion: true };
		}
		return { agree: next };
	}

	private recordEpisode(
		goalId: string,
		contract: Contract,
		skillId: string,
		versionId: number,
		request: GoalRequest,
		inputHash: string,
		plan: unknown,
		result: unknown,
		evaluation: unknown,
		status: string,
		started: number,
	): void {
		this.store.recordEpisode({
			episodeId: goalId,
			contractId: contract.id,
			skillId,
			versionId,
			goal: {
				contract: `${contract.id}@${contract.revision}`,
				directory: request.directory,
				constraints: request.constraints ?? {},
			},
			inputHash,
			plan,
			result,
			evaluation,
			status,
			runtimeMs: performance.now() - started,
		});
	}

	private loadCompiled(program: Program): Bytecode | undefined {
		const hash = programHash(program, PRIMITIVE_LIBRARY_HASH);
		const row = this.store.compiled(hash);
		if (!row) return undefined;
		try {
			if (row.compiler_version !== COMPILER_VERSION) throw new Error("compiler version changed");
			const bytecode = JSON.parse(this.store.readArtifact(row.bytecode_hash).toString("utf8")) as Bytecode;
			verifyBytecode(bytecode, this.limits);
			return bytecode;
		} catch (error) {
			// Incompatible or corrupt compiled artifacts fall back to the verified interpreter.
			this.store.dropCompiled(hash, (error as Error).message);
			return undefined;
		}
	}

	/* --------------------------------------------------------------------- operations */

	async improve(
		skillId: string,
		options: {
			explore?: boolean;
			isolate?: boolean;
			seed?: number;
			policy?: "active" | "reference";
			shadowMin?: number;
			signal?: AbortSignal;
			/** Continue a paused campaign from its checkpoint. */
			resume?: string;
		} = {},
	): Promise<CampaignReport> {
		const refusal = this.quotaRefusal();
		if (refusal) throw new Error(refusal);
		const head = this.store.head(skillId);
		if (!head) throw new Error(`no skill ${skillId}`);
		const contract = getContract(head.version.contract_id);
		const active = this.policy();
		const policy = options.policy === "reference" ? REFERENCE_POLICY : active.record;
		return runCampaign(this, {
			skillId,
			contract,
			policy,
			policyHash: options.policy === "reference" ? digest(REFERENCE_POLICY) : active.hash,
			explore: options.explore,
			isolate: options.isolate,
			seed: options.seed,
			shadowMin: options.shadowMin,
			signal: options.signal,
			resume: options.resume,
		});
	}

	improveSearchPolicy(options: Parameters<typeof improvePolicy>[1] = {}): Promise<PolicyCampaignReport> {
		const refusal = this.quotaRefusal();
		if (refusal) return Promise.reject(new Error(refusal));
		return improvePolicy(this, options);
	}

	rollback(skillId: string, toVersion?: number): { from: number; to: number } {
		return this.store.rollback(skillId, "operator request", toVersion);
	}

	/** Diagnostic run (spec section 19.4): all development, regression and stored counterexample cases. */
	test(skillId: string): {
		skill: string;
		version: number;
		cases: number;
		passed: boolean;
		failures: unknown[];
		reenabled: boolean;
	} {
		const head = this.store.head(skillId);
		if (!head) throw new Error(`no skill ${skillId}`);
		const contract = getContract(head.version.contract_id);
		const cases = [
			...contract.fixtures.development(),
			...contract.fixtures.regression(),
			...(this.store.regressions(contract) as Value[]),
		];
		const suite = evaluateSuite(contract, head.program, cases, { limits: this.limits, library: this.library() });
		let reenabled = false;
		if (suite.allCorrect && !head.promotionEnabled) {
			this.store.setPromotionEnabled(skillId, true, "diagnostic run passed");
			reenabled = true;
		}
		this.store.audit("diagnostic", skillId, {
			version: head.version.version_id,
			cases: cases.length,
			passed: suite.allCorrect,
		});
		return {
			skill: skillId,
			version: head.version.version_id,
			cases: cases.length,
			passed: suite.allCorrect,
			failures: suite.failures.slice(0, 10),
			reenabled,
		};
	}

	/**
	 * Compile the active program (spec sections 21.3 and 42.6): verify the bytecode, run the
	 * differential test on every known case, measure both engines with alternating order, and store
	 * the artifact only if nothing differs. The runtime then chooses an engine by measured speed.
	 */
	compile(skillId: string): {
		accepted: boolean;
		bytecode?: string;
		cases: number;
		mismatches: unknown[];
		interpreterMs: number;
		bytecodeMs: number;
	} {
		const head = this.store.head(skillId);
		if (!head) throw new Error(`no skill ${skillId}`);
		const contract = getContract(head.version.contract_id);
		const library = this.library();
		const bytecode = compileProgram(head.program, library);
		verifyBytecode(bytecode, this.limits);
		const inputs = [
			...contract.fixtures.development(),
			...contract.fixtures.regression(),
			...(this.store.regressions(contract) as Value[]),
			...this.episodeInputs(contract, 16),
		];
		const hostFor = this.hostFor(contract);
		const report = differential(head.program, bytecode, inputs, { limits: this.limits, library, hostFor });
		let interpreterMs = 0;
		let bytecodeMs = 0;
		for (let round = 0; round < 3; round++) {
			for (const input of inputs) {
				const options = { limits: this.limits, library, host: hostFor?.(input) };
				const order = round % 2 === 0 ? ["i", "b"] : ["b", "i"];
				for (const which of order) {
					const start = performance.now();
					if (which === "i") interpret(head.program, input, options);
					else runBytecode(bytecode, input, options);
					const elapsed = performance.now() - start;
					if (which === "i") interpreterMs += elapsed;
					else bytecodeMs += elapsed;
				}
			}
		}
		const accepted = report.mismatches.length === 0;
		const hash = programHash(head.program, PRIMITIVE_LIBRARY_HASH);
		const result = {
			accepted,
			cases: report.cases,
			mismatches: report.mismatches.slice(0, 10),
			interpreterMs: Math.round(interpreterMs * 1000) / 1000,
			bytecodeMs: Math.round(bytecodeMs * 1000) / 1000,
		};
		if (!accepted) {
			this.store.audit("compile_rejected", hash, result);
			return result;
		}
		const artifact = this.store.putArtifact(
			Buffer.from(canonical(bytecode)),
			"application/json",
			`compiler@${COMPILER_VERSION}`,
			"compiled",
		);
		if (artifact !== bytecodeHash(bytecode)) throw new Error("bytecode hash mismatch");
		this.store.putCompiled(hash, artifact, COMPILER_VERSION, { ...result, primitives: PRIMITIVE_LIBRARY_HASH });
		return { ...result, bytecode: artifact };
	}

	/** Library learning over the accepted programs of every skill (spec section 40.7). */
	mine(options: { keep?: number } = {}): AbstractionReport[] {
		const corpus = [];
		for (const row of this.store.skills()) {
			if (row.skill_id === POLICY_SKILL) continue;
			const head = this.store.head(row.skill_id)!;
			let contract: Contract;
			try {
				contract = getContract(head.version.contract_id);
			} catch {
				continue;
			}
			for (const version of this.store.versions(row.skill_id)) {
				if (version.status === "invalid") continue;
				corpus.push({
					id: `${row.skill_id}@${version.version_id}`,
					program: JSON.parse(this.store.programText(version.program_hash)!) as Program,
					inputBounds: contract.inputBounds,
					cases: [...contract.fixtures.development().slice(0, 4), ...contract.fixtures.regression()],
					granted: contract.granted,
					host: contract.host?.bind(contract),
				});
			}
		}
		const unique = [...new Map(corpus.map((entry) => [digest(entry.program), entry])).values()];
		const reports = mineAbstractions(unique, { limits: this.limits, library: this.library() });
		const kept = reports.slice(0, options.keep ?? 3);
		for (const report of kept) {
			this.store.putLibrarySkill(report.skill, {
				gain: report.gain,
				occurrences: report.occurrences,
				programs: report.programs,
				verified_cases: report.verifiedCases,
			});
		}
		this.libraryCache = undefined;
		return kept;
	}

	/** Program synthesis from examples (tier 5). Installing the result is an explicit, separate choice. */
	synthesize(
		task: ExampleTask,
		options: { maxCandidates?: number; maxSize?: number; install?: boolean } = {},
	): SynthesisResult & { installed?: string } {
		validateTask(task, this.limits);
		const result = synthesize(task, {
			limits: this.limits,
			library: this.library(),
			maxCandidates: options.maxCandidates ?? 20_000,
			maxSize: options.maxSize ?? 7,
		});
		if (!options.install || !result.found || !result.program) return result;
		const skillId = `user.${task.name}`;
		const contract = { id: `examples.${task.name}`, revision: 1 };
		this.store.ensureContractRow(contract.id, contract.revision, digest(task));
		this.store.installSeed(skillId, contract, result.program);
		this.store.audit("synthesized_skill_installed", skillId, {
			heldout: result.heldout,
			enumerated: result.enumerated,
			trust: "T3 generated; matched its examples only",
		});
		return { ...result, installed: skillId };
	}

	/** Run any installed skill on a structured input (example-defined skills have no oracle). */
	runSkill(
		skillId: string,
		input: unknown,
	): { version: number; output?: Value; error?: string; units?: number; evidence: string } {
		const head = this.store.head(skillId);
		if (!head) throw new Error(`no skill ${skillId}`);
		if (CONTRACTS.get(head.version.contract_id)?.granted.includes("read")) {
			throw new Error(
				`${skillId} reads file contents; use \`goal --contract ${head.version.contract_id} --dir PATH\``,
			);
		}
		const check = checkProgram(head.program, {
			limits: this.limits,
			granted: new Set(),
			library: this.library(),
			inputSummary: {},
		});
		if (!check.ok) throw new Error(`stored program rejected: ${check.error}`);
		const value = validateValue(head.program.input_type, input, this.limits);
		const run = interpret(head.program, value, { limits: this.limits, library: this.library() });
		const known = CONTRACTS.has(head.version.contract_id);
		return run.ok
			? {
					version: head.version.version_id,
					output: run.value,
					units: run.metrics.units,
					evidence: known
						? "contract skill: use `goal` for verified results"
						: "synthesized from examples; no oracle beyond them",
				}
			: {
					version: head.version.version_id,
					error: `${run.error.code}: ${run.error.message}`,
					evidence: "run failed",
				};
	}

	/* ------------------------------------------------------------------------ explain */

	/** Why the active version is active, generated only from stored evidence (spec section 46.4). */
	explainSkill(skillId: string): {
		skill: string;
		active: number;
		chain: unknown[];
		text: string[];
		facts: { predicate: string; object: unknown; confidence: number; provenance: string }[];
	} {
		const head = this.store.head(skillId);
		if (!head) throw new Error(`no skill ${skillId}`);
		const chain: unknown[] = [];
		const text: string[] = [];
		for (let cursor = this.store.version(head.version.version_id); cursor; ) {
			const report = JSON.parse(cursor.report_json) as {
				kind?: string;
				gate?: { verdict: string };
				release?: {
					release_set_id?: string;
					lower_bound?: number;
					mean_virtual_cost_reduction?: number;
					shifted_cost_ratio?: number;
					shadow?: string;
					lineage?: string[];
				};
			};
			chain.push({
				version: cursor.version_id,
				status: cursor.status,
				parent: cursor.parent_version,
				campaign: cursor.campaign_id,
				report,
			});
			if (cursor.seed) text.push(`Version ${cursor.version_id} is the human-authored seed (${cursor.status}).`);
			else if (report.release) {
				const r = report.release;
				text.push(
					`Version ${cursor.version_id} (${cursor.status}) replaced version ${cursor.parent_version}: it passed release set ${r.release_set_id} ` +
						`with a mean virtual-cost reduction of ${pct(r.mean_virtual_cost_reduction)} (lower bound ${pct(r.lower_bound)}), ` +
						`shifted-distribution cost ratio ${r.shifted_cost_ratio?.toFixed(3)}, shadow: ${r.shadow}. ` +
						`Changes: ${(r.lineage ?? []).join("; ") || "none recorded"}. Version ${cursor.parent_version} is retained as the rollback target.`,
				);
			}
			cursor = cursor.parent_version === null ? undefined : this.store.version(cursor.parent_version);
		}
		const rollbacks = this.store
			.auditLog(skillId, 20)
			.filter((entry) => entry.kind === "rollback")
			.map((entry) => `Rolled back: ${canonical(entry.payload)}`);
		return {
			skill: skillId,
			active: head.version.version_id,
			chain,
			text: [...text, ...rollbacks],
			facts: this.store.facts(skillId),
		};
	}

	explainEpisode(episodeId: string): unknown {
		const episode = this.store.episode(episodeId);
		if (!episode) throw new Error(`no episode ${episodeId}`);
		return {
			episode: episode.episode_id,
			status: episode.status,
			contract: episode.contract_id,
			skill: episode.skill_id,
			version: episode.version_id,
			goal: JSON.parse(episode.goal_json),
			input_artifact: episode.input_hash,
			plan: JSON.parse(episode.plan_json),
			result: JSON.parse(episode.result_json),
			evaluation: JSON.parse(episode.evaluation_json),
			runtime_ms: episode.runtime_ms,
			created_at: new Date(episode.created_at).toISOString(),
		};
	}

	status(): unknown {
		const integrity = this.store.verify();
		return {
			kernel_version: KERNEL_VERSION,
			data_dir: this.store.dataDir,
			integrity: integrity.ok ? "ok" : integrity.problems,
			promotion: this.store.paused ? `stopped: ${this.store.paused}` : "allowed",
			improvement_cpu_ms_left_today: Math.round(this.governor.remainingToday()),
			adapter: this.adapter?.id ?? "none",
			quota: this.quota(),
			effects_reconciled_at_open: this.recovered,
			campaigns_reconciled_at_open: this.interruptedCampaigns,
			plans_needing_attention: this.store
				.plans()
				.filter((plan) => plan.status === "unresolved" || plan.status === "partial")
				.map((plan) => ({ plan_id: plan.plan_id, status: plan.status })),
			skills: this.store.skills().map((row) => {
				const version = this.store.version(row.version_id)!;
				return {
					skill: row.skill_id,
					active_version: row.version_id,
					status: version.status,
					parent: version.parent_version,
					program_hash: version.program_hash.slice(0, 16),
					promotion_enabled: row.promotion_enabled === 1,
					compiled: this.store.compiled(version.program_hash) !== undefined,
				};
			}),
			library: [...this.library().entries()].map(([hash, skill]) => ({
				hash: hash.slice(0, 16),
				name: skill.name,
				params: skill.params.length,
			})),
			counts: this.store.stats(),
		};
	}

	/** Maintenance mode (spec section 4.3): compaction, retention and verification; no new behavior. */
	maintenance(options: { graceMs?: number } = {}): unknown {
		const retention = this.store.applyRetention(RETENTION);
		const gc = this.store.collectGarbage(options.graceMs);
		this.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		const integrity = this.store.verify();
		return { retention, gc, quota: this.quota(), integrity: integrity.ok ? "ok" : integrity.problems };
	}
}

function pct(value: number | undefined): string {
	return value === undefined || Number.isNaN(value) ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function summarize(
	contract: Contract,
	input: Value,
	output: Value,
	units: number | undefined,
): { [key: string]: unknown } {
	if (contract.id === "inventory.report") {
		const rows = output as { category: string; count: number; bytes: number }[];
		return {
			entries_examined: (input as Value[]).length,
			files_reported: rows.reduce((sum, row) => sum + row.count, 0),
			bytes_reported: rows.reduce((sum, row) => sum + row.bytes, 0),
			virtual_units: units,
		};
	}
	if (contract.id === "duplicates.report") {
		const rows = output as { path: string; copies: number }[];
		return {
			entries_examined: (input as Value[]).length,
			duplicate_files: rows.length,
			// Every visible copy is listed with its group's size, so each group contributes 1.
			content_groups: Math.round(rows.reduce((sum, row) => sum + 1 / row.copies, 0)),
			virtual_units: units,
		};
	}
	if (contract.id === "organize.plan") {
		return {
			entries_examined: (input as Value[]).length,
			moves_proposed: (output as Value[]).length,
			virtual_units: units,
		};
	}
	return { records_examined: (input as Value[]).length, matches: (output as Value[]).length, virtual_units: units };
}

function validateTask(task: ExampleTask, limits: ExecutionLimits): void {
	if (!/^[a-z][a-z0-9_-]{0,40}$/.test(task.name))
		throw new Error("task name must be lowercase letters, digits, _ or -");
	if (task.recordType.kind !== "record" || !task.recordType.fields[task.idField])
		throw new Error("record_type must be a record with the id field");
	if (task.examples.length < 2) throw new Error("need at least two examples (one to generate, one held out)");
	for (const example of task.examples) {
		validateValue(T.list(task.recordType), example.input, limits);
		validateValue(T.list(task.recordType.fields[task.idField]), example.output, limits);
	}
}

/** Kernel self-checks run at install: permutation equivalence, rejection of invalid programs, fuel. */
function quickSelfCheck(): void {
	const edge = recordBoundaryFixture() as unknown as Value;
	const expected = canonical(recordsFilter.oracle(edge));
	const context = { limits: INSTALLATION_LIMITS, library: new Map<string, LibrarySkill>() };
	for (const order of permutations(RECORD_BASELINE)) {
		const run = interpret(recordsFilterProgram(order), edge, context);
		if (!run.ok || canonical(run.value) !== expected) throw new Error("self-check failed: permutation equivalence");
	}
	const fuel = interpret(recordsFilter.seed(), edge, { ...context, limits: { ...INSTALLATION_LIMITS, maxFuel: 0 } });
	if (fuel.ok || fuel.error.code !== "fuel") throw new Error("self-check failed: fuel was ignored");
}

export function permutations<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) return [items.slice()];
	return items.flatMap((item, index) =>
		permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
	);
}

/**
 * End-to-end self-test in a temporary store (spec section 27 selftest, extended): permutation
 * equivalence, static rejection, fuel, a reference campaign that must reproduce the published
 * reference numbers, single use of release sets, rollback, compiled/interpreted agreement and
 * audit corruption detection.
 */
export async function selftest(): Promise<{ [key: string]: unknown }> {
	const dir = mkdtempSync(join(tmpdir(), "lattice-selftest-"));
	const lattice = Lattice.open(dir);
	try {
		lattice.init({ snapshot: false });
		const options = {
			limits: INSTALLATION_LIMITS,
			granted: new Set<never>(),
			library: new Map(),
			inputSummary: recordsFilter.inputBounds,
		};
		const invalid: unknown[] = [
			{ ...recordsFilter.seed(), body: { node: "call", op: "arbitrary_code", args: [] } },
			{ ...recordsFilter.seed(), body: { node: "var", name: "unbound" } },
			{
				...recordsFilter.seed(),
				body: {
					node: "filter",
					list: { node: "input" },
					param: "r",
					body: { node: "const", type: T.bool, value: true },
					maxItems: 1e9,
				},
			},
			{ ...recordsFilter.seed(), output_type: T.string },
			{
				...recordsFilter.seed(),
				body: {
					node: "map",
					list: { node: "input" },
					param: "r",
					body: {
						node: "call",
						op: "read_text",
						args: [{ node: "field", record: { node: "var", name: "r" }, name: "text" }],
					},
					maxItems: 10,
				},
				output_type: T.list(T.string),
			},
			nested(200),
		];
		for (const program of invalid) {
			if (checkProgram(program, options).ok) throw new Error("self-test failed: an invalid program was accepted");
		}
		const initial = lattice.store.head("records.filter")!.version.version_id;
		const report = await lattice.improve("records.filter", {
			explore: true,
			isolate: false,
			policy: "reference",
			shadowMin: 0,
		});
		const release = report.release as {
			parent_virtual_units: number;
			candidate_virtual_units: number;
			mean_virtual_cost_reduction: number;
		};
		if (report.status !== "promoted") throw new Error(`self-test failed: expected promotion, got ${report.status}`);
		const referenceMatch =
			release.parent_virtual_units === 594_668 &&
			release.candidate_virtual_units === 59_961 &&
			Math.abs(release.mean_virtual_cost_reduction - 0.8993017556599967) < 1e-12 &&
			report.development?.evaluations === 27;
		if (!referenceMatch) throw new Error("self-test failed: the campaign does not reproduce the reference results");
		let reuseRejected = false;
		try {
			lattice.store.reserveRelease("records.filter/r1/release/001", "camp_again", report.development!.bestHash);
		} catch {
			reuseRejected = true;
		}
		if (!reuseRejected) throw new Error("self-test failed: a consumed release set was reused");
		const compiled = lattice.compile("records.filter");
		if (!compiled.accepted) throw new Error("self-test failed: compiled and interpreted forms differ");
		lattice.rollback("records.filter");
		if (lattice.store.head("records.filter")!.version.version_id !== initial)
			throw new Error("self-test failed: rollback");
		const before = lattice.store.verify();
		if (!before.ok) throw new Error(`self-test failed: store not intact (${before.problems.join("; ")})`);
		lattice.store.db.exec("UPDATE audit SET payload = '{}' WHERE seq = 1");
		if (lattice.store.verify().ok) throw new Error("self-test failed: audit corruption was missed");
		return {
			selftest: "passed",
			permutations_checked: permutations(RECORD_BASELINE).length,
			invalid_programs_rejected: invalid.length,
			reference_campaign: {
				development_evaluations: report.development?.evaluations,
				parent_virtual_units: release.parent_virtual_units,
				candidate_virtual_units: release.candidate_virtual_units,
				mean_virtual_cost_reduction: release.mean_virtual_cost_reduction,
			},
			compiled_differential_cases: compiled.cases,
		};
	} finally {
		lattice.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

function nested(depth: number): unknown {
	let body: unknown = { node: "const", type: T.bool, value: true };
	for (let i = 0; i < depth; i++) body = { node: "call", op: "not", args: [body] };
	return { ...recordsFilter.seed(), output_type: T.bool, body };
}
