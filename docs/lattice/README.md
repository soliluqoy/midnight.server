# Lattice-1 in midnight.server

This is an implementation of the Lattice-1 pseudo-RSI harness specification (`pseudo_rsi_harness_implementation.md`, 2026-09-28): a small fixed kernel, a typed and bounded program layer that is generated, tested, promoted, rolled back and compiled, and a second level that improves the search policy. It lives in `packages/coding-agent/src/lattice/` and has no dependencies beyond the runtime (`node:sqlite` under Node 24, `bun:sqlite` under Bun, `node:worker_threads`, `node:crypto`). It is a standalone research tool: nothing in a coding session uses it.

Everything here is measured in a declared virtual-cost model on synthetic or local data. It is not evidence of general intelligence, and a passing test suite is not a proof of correctness (spec section 38.1).

## Removed from the harness (2026-09-28)

Until 2026-09-28 the harness ran a policy loop on this kernel: its feature switches were a Lattice skill, `harness.policy`, and live sessions were split between the active version and a candidate. It was removed with the lean harness (`docs/WORKFLOW_PLAN.md`). Its evidence was a proxy, since live requests have no hidden grader, and splitting sessions meant two sessions on the same project could behave differently. Harness defaults are now changed only through the eval (`scripts/harness-eval.mjs`).

## Running it

```bash
node packages/coding-agent/src/lattice/cli.ts selftest                       # end-to-end, temporary store
node packages/coding-agent/src/lattice/cli.ts init                           # store under $LATTICE_DATA or ~/.midnight.server/lattice
node packages/coding-agent/src/lattice/cli.ts goal "inventory ./some/dir"    # template adapter
node packages/coding-agent/src/lattice/cli.ts goal --contract records.filter --input records.json
node packages/coding-agent/src/lattice/cli.ts improve skill inventory.report # one budgeted campaign
node packages/coding-agent/src/lattice/cli.ts explain skill inventory.report # evidence behind the active version
node packages/coding-agent/src/lattice/cli.ts improve policy                 # level 2 (research budget)
node packages/coding-agent/src/lattice/cli.ts goal --contract organize.plan --dir ./downloads  # propose moves
node packages/coding-agent/src/lattice/cli.ts goal "duplicates in ./downloads"  # files with identical content
node packages/coding-agent/src/lattice/cli.ts apply PLAN_ID                  # approve: journaled, verified moves
node packages/coding-agent/src/lattice/cli.ts undo PLAN_ID                   # conditional compensation
node packages/coding-agent/src/lattice/cli.ts serve --idle-ms 300000         # local API plus idle-time improvement
node packages/coding-agent/src/lattice/cli.ts help                           # all commands
```

`npm run lattice -- <command>` is the same from the repository root. Every command prints one JSON document.

The reference program from spec section 27.2 is kept verbatim in [`lattice_reference.py`](lattice_reference.py) (milestone M0). Its self-test and campaign were run once while extracting it; the TypeScript port reproduces its published numbers exactly (below), which is how the port is cross-checked.

## Layout

| Module | Spec | Responsibility |
| --- | --- | --- |
| `canonical.ts`, `random.ts` | 37.3, 27.2 | Canonical JSON and SHA-256; CPython-compatible Mersenne Twister, so fixtures and bootstrap resamples match the reference draw for draw |
| `ir.ts`, `primitives.ts`, `typecheck.ts` | 8, 39.1-39.3 | Bounded expression IR (no recursion, every loop bounded), primitives with effect classes and pre-charged virtual costs, and a checker inferring type, effects, totality and upper bounds per node |
| `interpreter.ts` | 39.5, 39.7 | Explicit-stack interpreter: fuel debited before each primitive, step, iteration, call-depth, deadline and output-size bounds, typed errors |
| `compile.ts` | 21.3, 42.6 | Bytecode with validated operand tables, a VM with identical fuel accounting, differential testing |
| `contracts.ts` | 10.1, 37.4, 38.2 | Kernel-owned contracts: oracle, postconditions, input validation, seed program, development/regression/release/shifted fixture families, fuzzers |
| `evaluator.ts` | 10, 38 | Judging against oracle and postconditions, paired gains, percentile bootstrap, alpha spending, the conjunctive release gate |
| `mutate.ts`, `search.ts` | 11, 39.4, 40.3-40.6 | Mutation operators with checked preconditions, hill climbing (reference) and beam search with screening, archive, diversity, counterexample search and shrinking |
| `campaign.ts`, `worker.ts` | 12, 29.3, 38.3, 4.1, 42.5 | The improvement protocol A-H; development search in an isolated worker thread; pause with a structured checkpoint and resume |
| `abstraction.ts`, `synthesis.ts` | 40.2, 40.7, 10.6 | Library learning by anti-unification; typed bottom-up enumeration with counterexample-guided rounds |
| `metapolicy.ts` | 41 | Level 2: search policies as data, meta-evaluation over task families, promotion on fresh families |
| `store.ts` | 7, 15, 19, 44 | SQLite (WAL, foreign keys, full sync), versions and heads, compare-and-swap promotion, rollback, release consumption, audit chain, integrity checks, recovery, snapshots, content-addressed artifacts, GC, ledger |
| `governor.ts` | 9.4, 14, 42.2-42.4 | Budget tiers, daily CPU ledger with reservation, economic gate, UCB selection |
| `broker.ts` | 13, 43.1-43.4 | Filesystem capabilities (signed, expiring, episode-bound; `list`, `read`, `rename`), inventory scans with file identities, a streaming content-hash host checked against the inventory, a bounded `readText` host |
| `effects.ts` | 13.6, 43.5-43.8 | Effect plans from intents, apply with a prepared/committed journal, conditional compensation, crash reconciliation |
| `adapter.ts` | 16, 37.2 | Optional goal adapter: exact task templates, output untrusted |
| `kernel.ts` | 2, 5, 6, 29 | The hot path (cache, active skill, engine choice, verification, canary), operations, explanations, self-test |
| `server.ts`, `idle.ts`, `cli.ts` | 5.2, 14.3, 17, 44.6-44.8 | Bounded two-lane event loop; idle-time scheduler with backoff; local API on a named pipe or Unix socket; the CLI |

## Kernel invariants (spec section 5)

| # | Invariant | Mechanism | Test |
| --- | --- | --- | --- |
| 1 | No writes outside declared capabilities | Programs have no write primitive; they return intents. Only the broker renames, under a `rename` capability bound to the plan's root and episode, inside the root, never through a link component | `lattice-effects`, `lattice-store` broker test, static admission tests |
| 2, 3 | Candidates cannot alter the evaluator or protected metrics | Candidates are IR data; oracles, postconditions and gates are kernel code; the evaluator hash is stored per contract revision and a silent change is refused | `rejects a changed contract that did not bump its revision` |
| 4 | No self-granted permissions | Effects are inferred, not declared by the candidate; manifests and policies are clamped by installation limits | static admission, `clampPolicy` test |
| 5, 6 | Parent or signed seed; rollback target | `CHECK (seed = 1 OR parent_version IS NOT NULL)`, foreign keys to the parent; rollback is a pointer change | rollback tests |
| 7 | Every execution is budgeted | Fuel, steps, items, depth, output bytes, deadlines; worker heap caps; campaign CPU bound; daily ledger | interpreter and governor tests |
| 8 | Append-only audit chain, including every broker action | `record = H(previous, time, kind, subject, payload)`, verified on open; every effect transition (proposed, prepared, committed, failed, compensated, unresolved) is an audit record | audit tampering test, effect journal test |
| 9 | Failed promotion leaves the old version active | Promotion is one `BEGIN IMMEDIATE` transaction; the gate runs first | crash-after-reservation test; process killed before and after the promotion commit |
| 10 | Integrity failure stops promotion | A failed check on open sets `paused`; `promote` refuses | audit tampering test |
| 11 | Hard constraints outrank score | The release gate is a conjunction; no gain compensates a failed condition | release gate test |
| 12 | May decline when under-specified | Missing contract, input or directory yields `needs_clarification`; unavailable capabilities yield `declined` | clarification tests |

## Definition of done (spec section 34)

| Requirement | How |
| --- | --- |
| Receive a structured goal locally | `lattice goal --contract ...`, `POST /v1/goals` on the local pipe |
| Execute a manually authored skill safely | Human-authored seeds, type-checked and run under fuel |
| Record an episode | `episodes` table; inputs and reports stored as content-addressed artifacts |
| Evaluate success and cost | Oracle and postconditions; virtual units per run |
| Synthesize a candidate mutation | Nine mutation operators (including loop-invariant hoisting and implied-guard insertion); bottom-up enumeration for example-defined tasks |
| Reject invalid or unsafe candidates | Static admission, then development and regression cases, then counterexample search |
| Test on regression and held-out suites | Development, regression, release and shifted families; release sets consumed once |
| Promote a verified improvement | Frozen plan, reserved release set, conjunctive gate, compare-and-swap into canary |
| Roll back a failed promotion | Automatic rollback when a canary fails at runtime (the goal is then answered by the restored parent) or disagrees with its parent and the oracle rejects it; `lattice rollback`; for effects, `lattice undo` |
| Extract a reusable subskill | `lattice mine`: anti-unified abstractions with verified rewrites |
| Compile a stable skill | `lattice compile`: bytecode accepted only after a differential test; the runtime picks an engine by measured speed |
| Continue without optional adapters | `--no-adapter`; structured goals bypass the adapter (tested) |
| Explain why the active version was chosen | `lattice explain skill`, generated only from stored evidence |

## Measured results

All from this repository on Windows 10, Node 24.21. Costs are virtual units (declared primitive charges), not CPU time.

**Reference reproduction (M0, M1).** The TypeScript campaign over the same fixtures gives the published reference results exactly: 27 development evaluations, winning order `is_log, old_enough, size_positive, visible, text_hit`, release units 594,668 to 59,961, mean paired reduction 0.8993017556599967, bootstrap lower bound 0.8918515609205374, shifted ratio 0.3438064992314412. The conventional cost/selectivity ordering reaches the same result; the harness reproduces an ordinary optimization, as the spec notes.

**Inventory report (a real read-only workload).** Starting from a deliberately naive seed (classification repeated per category, twice), one isolated campaign within the 10 CPU-second bound found: hoisting the repeated filter into a `let`, moving the most common extension class first, and testing `kind` before classifying. Release set 001: 3,315,209 to 1,478,586 units, mean reduction 55.4% (lower bound 55.1%, alpha 0.01), shifted-family cost ratio 0.479, shadowed on 5 live snapshots of repository directories, promoted to canary, then champion after 5 agreeing live runs. The compiled form of the result passed the differential test on 17 cases and ran 1.6 times faster than the interpreter in wall time.

**Organize plan (effects, M9).** The seed rebuilds the list of all paths inside the per-file loop and classifies each file three times. A campaign within the 10 CPU-second bound hoisted the loop-invariant path list and reordered classification branches: release set 001 mean reduction 26.5% (lower bound 26.4%). A standalone search that also merged the three classifications reached 34%. It once proposed dropping the `kind = file` check, which no fixture could refute; adding a directory named like a file (`photos.png/`) to the regression suite made the counterexample search reject it. Applying a plan moved only what the plan listed, and undo restored the tree exactly, removing only the folders the plan created.

**Duplicate files (sections 25, 43.4).** `duplicates.report` lists visible files whose content appears more than once, read through the broker's content-hash host. The seed hashes both files of every pair. `content_hash` declares that equal digests imply equal sizes (the host refuses a file whose byte count differs), and the `insert_implied_guard` operator uses such declarations to test the cheap argument first. One isolated campaign found the size-before-hash guard at both comparison sites without being told: release set 001 went from 184,934,154 to 3,581,176 units, mean reduction 98.1% (lower bound 98.0%), shifted-family ratio 0.245 (many equal sizes, where the guard helps least), shadowed on a rescanned live directory. The compiled form passed its differential test.

**Library learning and synthesis (M7).** From three accepted programs of the form `and(ext = C1, age >= C2, not hidden)`, mining produced one abstraction with three parameters (gain 8 nodes, 18 verified cases). On four held-out tasks with new constants and a budget of 20,000 enumerated candidates: 0 of 4 solved without the library, 4 of 4 with it (at most 758 candidates each, all held-out examples reproduced). Without the library the same size-6 predicate needs 567,813 candidates.

**Level 2 (M8, bounded).** Policies are scored by the area under the best-valid-cost curve over evaluator work (case runs weighted by input size), with identical budgets and seeds, against the parent and a random-search baseline. A default-settings campaign selected a policy that disables `split_filter` (selection score 0.112 vs 0.099; random 0.099), then confirmed it on a fresh task family (paired lower bound +0.0019, final quality not worse) and promoted it. The effect is small; this is an existence check of the mechanism, not a claim of compounding improvement (spec section 41.5).

## Deviations from the specification

1. **TypeScript, not C++.** The spec chooses C++20 for a standalone native runtime. Here the runtime sits in a TypeScript monorepo; Node 24 supplies SQLite, worker threads and crypto without new dependencies. The C ABI (section 28.4) and the sanitizer matrix (section 28.6) do not apply.
2. **Isolation is a worker thread, not WebAssembly or a process sandbox.** Candidates are IR interpreted by kernel code, so there is no arbitrary code to contain; the worker bounds memory (heap cap) and time, and receives no store, policy file or release data. It is not a privilege boundary (section 44.9). Arbitrary plugins are not supported.
3. **CPU budgets are enforced through wall time** in single-threaded, CPU-bound phases (the worker's search, level-2 scoring); the ledger reconciles measured process CPU afterwards.
4. **Effects are local renames only.** The broker moves files within one directory tree after explicit approval of a plan hash, with a prepared/committed journal, verification, compensation and crash reconciliation (sections 43.5-43.7). Content writes, deletes, cross-volume moves (refused: `EXDEV` stops the plan), external messages and processes are not supported. Undo is conditional: it never overwrites a newer change, and after a crash between rename and commit it keeps directories it cannot prove it created.
5. **Live verification uses postconditions and schemas; the oracle runs only in evaluation**, in campaign shadowing, and to adjudicate a canary disagreement. Running the full oracle on every live task would make it the product.
6. **The local API** is HTTP over a named pipe or Unix socket with a per-installation token; no TCP port is opened. Idle-time improvement runs only in `serve --idle-ms`; it resumes paused campaigns first, gates new ones economically and backs off exponentially. Thermal and battery signals (section 42.3) are not read.
7. **Timing claims** use the virtual cost model; wall-time comparisons (section 38.6) are limited to the interpreter/bytecode measurement.
8. **Planning tiers (section 9.1).** The hot path uses tier 0 (exact cache) and tier 1 (the active skill, interpreted or compiled). Tiers 4 (mutation) and 5 (synthesis) run only in explicit campaigns and `synthesize`. Tier 2 (composing skills), tier 3 (parameter search) and tier 6 (model proposals) are not implemented: no current contract is solved by composing others, and every constant in the current contracts is part of the task definition, which section 39.4 says must not be tuned.
9. **Semantic memory** holds only campaign cost profiles (with provenance and expiry); there is no episode clustering or fact extraction beyond that.
10. **Installation limits** allow 512 AST nodes (section 40.1 proposes 64 for searched skills, to be measured); readable seed programs for the inventory and organize contracts need 160-310 nodes.
11. **Retention** releases episode inputs after 30 days and reports after 90 days without reuse, and cache entries after 7 days; episode rows keep the content hash, so provenance stays. There is no sampling of successful episodes.
12. **Content reads are a verified bounded read, not a filesystem snapshot (section 43.3).** `content_hash` streams SHA-256 and checks each file's size, modification time and file ID against the inventory before and after reading; a change fails the goal with "unstable input". A writer that restores size and modification time can go unnoticed. The kernel stores inventories, never file bytes, so read contracts skip the exact cache, and their live episodes are replayed by rescanning the directory (shadow and compile only; the search worker holds no read capability). Release and development data for them come from a synthetic content world.

## Operations

- **Pause and resume (section 42.5).** When interactive work arrives, a background search stops between candidates and returns a structured checkpoint (the beam and generator state at the start of the interrupted depth, everything evaluated, work spent, the exact cases); the campaign is stored as `paused` and `improve skill ID --resume CAMPAIGN` (or the idle scheduler) continues it. A checkpoint is refused if the parent, primitives, contract, policy or cases changed. Work before the pause counts against the budget.
- **Quota (section 42.1).** Local state is capped at 256 MiB (database plus referenced artifacts). At the cap, new goals are declined and campaigns refused with the reason; `lattice maintenance` applies retention and garbage collection.
- **Crash injection (section 46.2).** `LATTICE_FAULT=<point>` makes the process exit hard at a named point; `lattice-faults.test.ts` kills a child process before and after the promotion commit, between artifact bytes and their row, during snapshot creation, after an effect is prepared or performed, and before and after a cancelled campaign's pause commits. After every crash the reopened store is old, new, or explicitly unresolved, and integrity verification passes. On open, a campaign left `running` by a process that no longer exists becomes `paused` if it has a search checkpoint and `aborted` otherwise, with an audit record; the checkpoint and the `paused` status commit in one transaction.
- **Failure classes (section 19.1).** Every goal that does not complete carries a `failure_class`: `input_ambiguity`, `invalid_input` (an addition: well specified but outside the contract), `missing_capability`, `permission_denial`, `deterministic_skill_bug`, `resource_exhaustion` or `external_dependency_failure`. A fuzz test sends 300 malformed goals and requires a structured answer for each.
- **Restore (section 44.4).** `lattice snapshot restore ID` validates the snapshot, restores through a validated copy, keeps the replaced database under `pre-restore-*`, and records the restore in the audit chain.

## Known limitations

- Release data comes from synthetic generator families; a shifted family changes one distribution. Real episodes feed development and the shadow phase, not release.
- The audit chain detects accidental and naive edits; anyone who can rewrite the database can recompute it (section 44.5).
- The mutation set and the grammar are small; the system cannot discover operations its primitives cannot express (section 37.1).
- Level-2 gains are small and measured on few task families.
