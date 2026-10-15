# EVIDENCE Phase 0 — baseline and lifecycle design

> Phase 0 deliverable: characterization tests and an implementation proposal, not shipped recovery behavior.
> Resume work through [`EVIDENCE_BUILD_PLAN.md`](../EVIDENCE_BUILD_PLAN.md).
> At the Phase 0 checkpoint, production files, persisted schemas, commands, defaults, and dependency pins were unchanged. Section 10 records subsequent internal-model work; live behavior still remains v1.

## 1. Scope and decision boundary

The selected first milestone includes capacity recovery, structured review reasons, the minimum relationship semantics needed by an advisory audit, an opt-in investigation skill, and that audit. Defer claim maturity labels, dedicated test-evidence types, rich UI, excerpt-aware freshness, strict gating, and live model evaluation.

Phase 0 inventories the current code and defines testable expectations. Phase 1 must review the proposed rollover interaction and compatibility policy before implementing them. Approval of the milestone is not approval to upload logs, perform paid evaluation, upgrade Pi, or automatically migrate sessions.

The paper motivates explicit evidence/conclusion/gap maintenance. It does not require copying its search tools, full-history prompting, one-operation-per-turn rule, or final-answer gate. This specification is based on repository behavior; Phase 0 does not revalidate the paper's experimental claims.

## 2. Current implementation inventory

| Surface | Authority | Current contract / risk |
| --- | --- | --- |
| Persisted event type | `src/evidence/model.ts`, `ENTRY_TYPE` | `midnight-evidence-v1`; event `version: 1`; add/retract/resolve/review |
| Record | `RecordSchema` | ID, kind, text, creation time, lifecycle status, refs, applicability, automatic flag; optional source, supersedes, reason, review |
| Source | `SourceSchema`, `src/evidence/source.ts` | File path/range/excerpt/original-byte hash; or bounded tool metadata/hash, optional parent ID and triage hashes |
| Projection | `EvidenceLedger.apply` | Append events are authoritative; map stores latest record projections; malformed/semantically invalid events increment `invalidEvents` |
| Public operation | `ParamsSchema`, `EvidenceRuntime.execute` | list/add/retract/resolve/check; review is internal, not a public action |
| Result | `ResultSchema` | Version 1, warning, summary, records, total, nextOffset; identical structuredContent and details, with JSON text content |
| Persistence | `EvidenceRuntime.append` | Validate a copied projection before appending; publish next projection only after append returns |
| Branch replay | `sync`, `replay` | Walk public parent pointers incrementally; rebuild from active branch when ancestry changes; ignore unrelated entry types |
| Async lifecycle | `run`, `start`, `stop` | Explicit operations/checks serialized; generation and abort controller reject queued/replaced-session work |
| Passive lifecycle | `observeStart`, `observeResult` | Track call generation; synchronous results can arrive while an async operation awaits; not the same queue as explicit operations |
| File freshness | `check` | Check active file records without review, coalesce reads by requested path per check; preserve original source; never clear review |
| UI | `src/sidebar.ts`, `src/compact-tools.ts` | Sidebar consumes summary; compact result rendering explicitly recognizes `version === 1`; preserve full saved/model-facing result |
| Orchestration | `src/index.ts` | Registration/summary callback, evidence subcommand, checkpoint restore invokes evidence check |
| Context boundary | `registerEvidence`, README | No context/before-agent-start injection, no context-file editing, no implicit network/model calls |
| Regression consumers | `tests/evidence.test.ts`, `tests/panels.test.ts`, `tests/compact-tools.test.ts` | Reducer, runtime, sources, cancellation, branches, summary display, compact rendering |

### Bounds and their actual meaning

- **512 retained records**, including inactive records; not 512 active records. Supersession adds another record. Retraction does not reclaim a slot.
- **128 automatic receipts** counted across retained active and inactive records. Receipt exhaustion stops automatic capture, not necessarily explicit adds. `capacityReached` conflates this with the total-record cap.
- **32 active file evidence records**, not 32 distinct paths. Replacing one excludes its old ID from this preflight count. The reducer itself does not enforce this runtime-only limit.
- At most **16 unique refs**; text/reason/review at most **2,000 UTF-16 code units**, IDs at most 100.
- Source files: **1 MiB**, strict UTF-8, no NUL, contained requested and canonical paths, sensitive-path rejection; excerpt at most **100 lines / 4,000 UTF-16 code units**.
- List default **10**, maximum **20**. Exact ID lookup also returns inactive records on the active branch.
- Ordinary source read races are detected with size/mtime checks; this is not an adversarial transactional filesystem snapshot.
- Source/path validation occurs on capture. Replay validates the stored schema and model semantics, not historical source bytes or live path safety. Do not describe replay as recapturing or verifying sources.
- The projection is bounded, not the raw session log. Repeated lifecycle events can grow session history without adding records.

### Current summary semantics

`evidence` counts active evidence, including receipts and reviewed observations. `claims` counts only active claims without review. `review` counts active records with review. `gaps` counts active gaps. `receipts` counts all retained automatic records. A resolved gap with a retained review string is not included in the active review count. These are bookkeeping counts, not proof strength or semantic coverage.

## 3. Baseline transition contract

Review is an orthogonal string, **not** a lifecycle status. Unless noted, invalid reducer events return false and change only `invalidEvents`; invalid explicit runtime requests must not append or change the published projection.

| Transition | v1 result | Applicability / dependency effect | Test anchor in `tests/evidence.test.ts` |
| --- | --- | --- | --- |
| Add file evidence | Active source-linked record; evidence cannot have refs | Historical default at runtime | `file evidence retains bounded Unicode` |
| Add claim | Requires nonempty active evidence refs; source forbidden | Current default; inherits review from referenced reviewed evidence only when current | `applicability changes` / `references, supersession` |
| Add gap | Active, optional active refs of any kind; source forbidden | Historical default; refs do not distinguish concerns/support | `references, supersession` |
| Supersede active record | Same-kind new active record; old becomes superseded; original source retained | All affected dependent active records and resolved gaps reviewed; historical claims are not exempt from corrections | `immutable corrections` |
| Retract active record | Becomes retracted, retains source/refs | Same correction invalidation; no capacity reclaimed | `applicability changes` / `v1 capacity includes` |
| Review active source | Same lifecycle status, review string set | Current dependent claims reviewed; historical claims skipped; directly dependent resolved gaps reopen | `applicability changes` / frozen v1 fixture |
| Review active claim/gap | Same lifecycle status; review replaced, not accumulated | Propagates using current-only rule | `v1 resolution replaces concerns` |
| Resolve active gap | Requires nonempty active, non-review evidence refs; becomes resolved with reason | Replaces all previous gap refs; preserves an existing review string; resolution invalidates dependents through the generic propagation path | `v1 resolution replaces concerns` / `references, supersession` |
| Support of resolved gap reviewed/retracted/superseded | Gap becomes active, review set | Closure is no longer treated as sufficient; no automatic semantic re-resolution | `v1 resolution replaces concerns` / `references, supersession` |
| Mutate resolved/superseded/retracted record directly | Review/retract/resolve/supersede rejected | Resolved gap must first reopen through dependency invalidation; no public reopen action | `v1 resolution replaces concerns`; extend inactive-state cross-product in Phase 1 |
| File changed/unavailable | Source review set; same preserved excerpt/hash | Current claims reviewed, historical claims retained; matching bytes later do not clear review | `missing files are unknown` / `current claims become review-only` |
| Observed shell/edit/write completion, including failure | Current active claims lacking review receive review event | Does not analyze command harmlessness; does not mark every source changed | `current claims become review-only` |
| Reload/session-tree navigation | Replay selected branch, conservatively review current claims | Historical applicability does not assert current filesystem state; navigation never restores files | `native receipts persist` / `current claims become review-only` |
| Compaction/agent completion/explicit check | Recheck tracked unreviewed file observations | No injection or context editing; raw custom entries remain in branch history | `tracked symlink retargets` / `missing files are unknown` |
| Cancel/shutdown/session replacement | Reject queued or aborted operations; discard old-generation observed calls | No promised rollback after an append has committed | `concurrent codemode updates serialize` |
| Malformed replay | Ignore invalid event, count it, continue v1 replay | Does not imply complete/verified history | `frozen v1 events replay deterministically` |
| Full record map | Reject all adds, including correction | Existing records unchanged; retract still possible but cannot free capacity | `v1 capacity includes` / `runtime capacity failures persist nothing` |

**Propagation subtlety:** current-only invalidation skips a historical claim and traversal through that claim. A gap referencing only that historical claim may therefore remain unreviewed after a freshness-only source change. A gap directly referencing the source can reopen even with historical applicability. Do not infer a uniform applicability policy for all record kinds from the claim exemption.

**Other baseline subtleties:** a current claim can reference reviewed active evidence, but is immediately marked for review. A historical claim can reference it without inheriting freshness review. An add may not refer to its own superseded predecessor. A v1 resolved gap loses its earlier concern links in the current projection, although the original add event remains in history.

These are characterization facts, not endorsements of all v1 semantics. Phase 1 should keep the safety guarantees and explicitly change the confusing behavior rather than silently altering it during migration.

## 4. Relationship and review proposal

### Separate relationships

Proposed v2 relationships:

- Claim **support**: nonempty local evidence IDs.
- Gap **concerns**: the records/question it is about, retained across closure/reopening.
- Gap **resolvedBy**: evidence used for closure; retained as historical resolution provenance after reopening, clearly no longer sufficient.
- **Origin/replacement lineage**: qualified historical identity, not live supporting evidence.
- **Legacy refs**: explicitly ambiguous links where v1 did not record the intended relationship.

Bound each relationship list to 16 and bound the whole traversal by working-set capacity. Distinct edge types must not multiply into unlimited closure work. Detect cycles during snapshot validation even if ordinary new-record operations only point backwards.

A support correction/retraction invalidates current **and historical** interpretations relying on it. Freshness-only change does not falsify a historical claim. Resolution-support change reopens the closed gap; concern changes require reassessment and should conservatively reopen a closed gap until reaffirmed. A gap's historical applicability must not suppress closure-integrity checks. Document this last point as an intentional clarification from v1.

Resolution should preserve concern links and previous resolution provenance. Resolving a reviewed gap must not silently erase unrelated review causes. Design an explicit replacement/reassessment path for closed gaps; final operation naming and acknowledgement rules belong to Phase 1B/1C. No automatic redirects from old support to replacement evidence.

### Structured review

Proposed cause codes: `source_changed`, `source_unavailable`, `dependency_superseded`, `dependency_retracted`, `possible_worktree_change`, `session_reloaded`, `branch_changed`, `legacy_unspecified`.

Keep bounded reason text, affected dependency IDs where known, and explicit cause overflow/aggregation. Proposed bound: eight distinct causes per record, with overflow count and a persistent review-required bit; eviction must never make a record appear clean. Precise reason retention is still a Phase 1 design review item. Do not infer old cause categories by parsing arbitrary v1 prose. Restore/matching hashes and rollover never clear reasons. Corrections require explicit reassessment, not numerical confidence or automatic promotion.

## 5. Capacity recovery proposal (not implemented)

### 5.1 Explicit bounded working sets

Keep 512 as the maximum live projection size initially. Add an explicit rollover that selects a smaller investigation working set, preserving the old one in append-only session history. Do not silently evict, automatically roll over, raise the cap as the solution, or exempt corrections from bounds.

Proposed interaction (names and schema are provisional):

1. A read-only **preview rollover** selects record IDs and reports the full dependency closure, omitted active claims/gaps, review reasons, capacity, byte size, and a branch/projection token.
2. Explicit **commit rollover** supplies the selection and preview token. Recompute and validate against the same branch/projection; refuse stale previews.
3. Publish a new working set from one versioned snapshot event. The result names the new set and historical lookup route. No file recapture, semantic review clearance, or claim rewriting occurs.
4. Continue normal capture/correction. New captures still obey source/privacy bounds.

Do not silently select what matters. Empty selection may be allowed only as an explicit empty rollover with a clear omitted-work warning. This is archival, not deletion or proof that omitted gaps are resolved.

Proposed initial rollover budgets, subject to Phase 1 review:

- At most **256 carried records**, including inactive dependency records, leaving at least 256 record slots. This is a rollover budget, not a correction reserve pretending to solve capacity permanently.
- At most **2 MiB serialized UTF-8 event data**; enforce both record and byte limits before append.
- Retain the **32 active file records** and **128 retained automatic receipts** limits within each new working set. Report when carried receipts leave no room for new automatic capture.
- Bounded output: default 10/max 20 records; never return an entire snapshot implicitly.

If closure exceeds either bound, refuse without mutation and list actionable counts. User/agent must choose a narrower explicit selection; no dependency truncation. If all records are still relevant, this design cannot preserve all as simultaneously live and also free space. Report that limitation, leaving the previous set available for bounded historical inspection.

### 5.2 Identity and closure

Recommended representation: a working-set UUID plus stable record IDs. A carried record keeps its ID, creation time, source bytes/hash, applicability, lifecycle status, review reasons, and semantic relationships. It gains an origin locator identifying the prior set and snapshot/branch anchor. Newly authored records use new IDs. An external locator is qualified by working set and record ID; a bare ID in normal mutation/support parameters refers only to the current set.

This avoids assigning a new creation date to old evidence or rewriting support text. The same ID in different sets is not a claim of identical mutable projection state; the set qualifier and immutable event anchor disambiguate it. Existing v1 branches receive a synthetic legacy-set identity derived from stable session ancestry, not random replay-time values. Fork/clone identity mapping requires a dedicated test before shipping.

Closure rules:

1. Start from explicitly selected claims, gaps, or evidence (including explicitly selected resolved gaps).
2. Include support, concerns, resolution support, and ambiguous legacy dependency refs needed to interpret those records.
3. Include inactive referenced records as historical dependencies. A reviewed claim referencing superseded evidence must not lose that source or become fresh merely because ordinary add would reject that dependency.
4. Preserve referenced historical status; carry-forward is not implemented as ordinary `add` calls. Validate the snapshot as an exact bounded projection of the predecessor, with deliberate schema mapping only.
5. Keep replacement/origin lineage as qualified archive links; do not recursively copy every replacement ancestor into the live set. Historical inspection resolves those links within bounds.
6. Do not carry unselected dependents merely because their source is selected; preview must make omitted claims/gaps visible.
7. Validate every local semantic edge, unique ID, allowed status, closure bound, provenance locator, and review invariant before committing. No arbitrary agent-supplied snapshot contents.

Store a stable ancestry anchor and projection digest in the transition. Validate equality using a defined serialization, not object insertion-order assumptions. Archive lineage must be reachable from the active branch; a known ID on a sibling branch is not authorization to inspect or mutate that branch through this tool.

### 5.3 Storage, replay, and retrieval

Use a distinct v2 custom entry type with a discriminated schema: first a migration/rollover snapshot, then scoped incremental events. The snapshot contains the complete bounded new working set and predecessor/origin metadata; do not split it into begin/copy/end events whose prefix could appear as a successful partial rollover.

- Incremental operation: continue walking parent pointers only for new ancestors.
- Cold replay: find the latest recognized valid snapshot on the active ancestry, initialize from it, and apply later events. A legacy branch without one replays v1.
- Do not maintain all historical sets in the runtime map or load them during rendering. Pi itself already owns its loaded session tree; this design bounds additional evidence projection/caches, not Pi's overall memory.
- A first discovery scan can still be proportional to branch length. Historical lookup must be resumable and report incomplete results, not claim constant-time replay.
- Proposed lookup budget: inspect at most 2,048 session entries per call, return at most 20 records, and cache at most two historical projections. Use branch-bound continuation cursors, generation invalidation, and abort checks. These are proposed operational limits to test, not existing guarantees.
- Historical output labels the set, lifecycle/review state **as of that set's archival boundary**, and whether the scan completed. It never asserts current-worktree validity. Later replacement links may require a separate bounded lookup.
- Do not perform disk writes, source checks, or archive scans from sidebar rendering.
- Full history remains in Pi session entries. Compaction does not delete it. An in-memory session still has no durable archive after exit.

### 5.4 Commit boundary and interruption

Public Pi 1.2.0 APIs provide `appendEntry` (void return) and session-manager leaf/entry/branch inspection. The installed `_appendEntry` updates the in-memory tree before synchronous `_persist`. One event gives a coherent **logical replay boundary**, not a filesystem transaction, fsync guarantee, or all-or-nothing durable write.

Required implementation sequence:

1. Queue the operation, bind session identity/generation/branch anchor, check cancellation.
2. Compute preview/closure asynchronously only where needed. Before commit, resync and compare the expected evidence projection/ancestry. Reject stale selection if passive observations or another operation changed it.
3. Build and validate an isolated next projection and event bytes. Do not mutate the live ledger during validation.
4. Recheck signal and session/branch generation immediately before the synchronous append. No await between this check, append, and local projection adoption.
5. Append one event. On normal return, adopt and publish the validated projection. Cancellation after successful append cannot roll it back; report the committed state honestly.
6. On exception, **do not automatically retry**, claim success, or pretend rollback. Pi may already contain the event in memory. Mark persistence outcome uncertain, reconcile visible ancestry using a unique operation ID, and block further mutations until recovery establishes a coherent state. Reload can establish what actually survived; do not promise to repair Pi's raw JSONL silently.

All automatic receipt/review writes must participate in the same commit-ordering policy or be revalidated at the commit boundary. Current synchronous passive observers are a race surface to test. A transition should never lose a receipt/review arriving during preview or revive a claim invalidated just before commit.

## 6. Versioned compatibility and migration

| Input | Required future behavior |
| --- | --- |
| Valid v1-only branch | Read without rewriting history; preserve current semantics until an explicit transition |
| v1 review prose | Map to `legacy_unspecified`, retaining exact bounded reason, not a guessed precise category |
| v1 claim refs | Map to support without inferring maturity or semantic strength |
| v1 active gap refs | Preserve as legacy ambiguous relationships; do not assume they were concerns rather than support |
| v1 resolved gap refs | Preserve as resolution support; original concern list is unknown unless explicitly recovered from validated history |
| v1 reopened gap | Preserve ambiguity/history; current refs may be old resolution evidence rather than concerns |
| v1 inactive dependency | Carry exact inactive projection where required; never reactivate it to satisfy new-add validation |
| Malformed v1 event | Retain invalid-event count/diagnostic; fixture demonstrates current skip behavior; migration must report incomplete provenance |
| Unknown newer evidence version or malformed v2 transition | Mark projection incomplete/read-only; do not silently treat an earlier prefix as authoritative writable state |
| v1 writes after v2 on same ancestry | Detect incompatible writer/history; refuse automatic merge or silent resurrection of the legacy set |
| Foreign/sibling origin | Reject lookup/mutation unless it is on the selected branch ancestry |

**Downgrade caveat:** the current binary ignores a new custom entry type and may continue writing the old v1 projection. New code cannot retrofit fail-closed behavior into already installed old binaries. README/release notes must prohibit writing migrated branches with old Midnight, describe version requirements, and explain recovery/inspection using the new reader. Merely changing the entry type is not downgrade safety. If safe mixed-version writing becomes a requirement, stop and redesign before Phase 1.

Result schemas and compact rendering require explicit migration too. Do not return a v2 shape while retaining `version: 1`. Keep old-result rendering for saved transcripts, add new-result rendering, and test fallback behavior for unknown versions. Sidebar summary changes and receipt-count distinctions must be deliberate, not accidental consequences of storage migration.

## 7. Regression scaffolding delivered in Phase 0

`tests/fixtures/evidence-v1.json` is fixed synthetic **event data**, not a session JSONL file. It contains evidence, a historical claim, a gap, resolution, ambiguous review prose, and malformed entries. Keep literal v1 content frozen so future migrations cannot regenerate away old semantics.

Five additional tests in `tests/evidence.test.ts` cover:

1. Full retained map blocks supersession without partially changing source/dependents; retraction does not free space.
2. Resolution overwrites concern refs, retains review, rejects direct closed-record updates, and reopens on support review.
3. Frozen v1 replay does not mutate input, counts three invalid events, preserves historical claim behavior, reloads deterministically, and isolates sibling branches through public Pi APIs.
4. Runtime exhaustion appends no failed updates or passive receipts; retraction persists but new adds remain blocked; rejected requests do not become invalid stored events.
5. Thirty-two captures of the same path reach the active-file-record limit, while same-slot correction remains allowed below total capacity.

The capacity tests intentionally **pass while documenting the existing defect**. Phase 1 must add successful explicit recovery tests, not reinterpret these as evidence recovery already exists. The fixture harness uses `SessionManager.inMemory`; it does not prove disk durability or migration across Pi versions.

## 8. Phase 1 implementation/test matrix

Unchecked rows are future work, not passing tests or current guarantees.

| Done | Scenario | Required assertion / intended location |
| --- | --- | --- |
| [x] | Capacity baseline | Five additions above; focused evidence suite |
| [ ] | Near-full correction and rollover | Exactly one transition; preserved old records; subsequent correction succeeds; `tests/evidence.test.ts` or focused lifecycle suite |
| [ ] | Closure rejection | Record/byte/file/receipt limits; no partial append, omitted edge, or silent truncation |
| [ ] | Reviewed/inactive support | Preserve source, status, applicability, reasons, timestamps and concern/resolution links |
| [ ] | Full lifecycle cross-product | Active/resolved/retracted/superseded × review/retract/resolve/replace, with explicit differences from v1 |
| [ ] | Relationship propagation | Transitive concerns/support, closed-gap reopening, historical-claim barrier, cycles, unsupported refs |
| [ ] | Structured causes | Multiple simultaneous causes, deduplication, overflow, legacy mapping, no implicit clearance |
| [ ] | Historical lookup | Old set/chain readable; pages/cursors bounded; unknown and incomplete distinguished; sibling denial |
| [ ] | Branch movement | Before/after snapshot; reload, fork/clone, compaction; no filesystem restoration |
| [ ] | Cancellation | Before preview, during scan, queued commit, generation replacement, after append; no stale publication |
| [ ] | Passive interleaving | Receipt/review arrives during async capture/preview/check; stale token rejected or reconciled without loss |
| [ ] | Append exceptions | Throw before append, after in-memory append, and persistence failure; uncertain state, no automatic retry |
| [ ] | Disk replay | Temporary persistent Pi session survives reopen, committed snapshot round-trips; malformed-tail handling follows Pi contract |
| [ ] | Version compatibility | Frozen v1, mixed valid history, malformed v2, future version, incompatible old-writer event; fail-closed limits explicit |
| [ ] | Renderer/result compatibility | v1 saved result and v2 new result; raw/model-facing data unchanged; compact/panels tests |
| [ ] | Privacy and bounds | No source reread/upload on rollover; no commands/output copied; Unicode/path/byte bounds unchanged |
| [ ] | Workflow/audit | Later phases: explicit selection, unresolved gaps, stale sources, bounded graph checks; never semantic verification |

## 9. Validation and next handoff

- Focused Phase 0 run: `node --experimental-strip-types --test tests/evidence.test.ts` — **18 passed, 0 failed, 0 skipped; exit 0**.
- `npm run check`: initial exit 1 for one formatting difference; formatting corrected, rerun exit 0 (Biome and TypeScript).
- `npm test`: exit 0; **141 tests, 140 passed, 0 failed, 1 skipped**. Checkpoint symlink-replacement test skipped because symlink creation was unavailable on this host; evidence symlink tests passed. No test rerun after the formatting-only change.
- Full-suite log triage: local via `auto`, 0 provider requests, 23 ms total / 0 ms provider wait. Original totals and skip reason inspected; actual command exit codes captured separately. Logs remain ignored under `.artifacts/evidence-phase-0/`.
- `git diff --check`: passed. Root-plan Handoff 002 records the resumable state.
- No production or UI behavior changed; no manual fullscreen, provider, packaging, install, or benchmark validation is warranted for this slice.
- Known unresolved implementation problem: v1 capacity exhaustion still blocks corrections. Recovery, v2 persistence, structured relationships, and audit remain unimplemented.
- Phase 0 next action was to review the proposed rollover UX, bounded snapshot/identity policy, and downgrade constraint. Approval was subsequently obtained; see section 10. Keep this document as the baseline rather than rewriting old behavior as though it never existed.

## 10. Phase 1A follow-up — approved internal-model slice

The user explicitly approved preview + commit rollover, 256 carried records / 2 MiB, dependency/review preservation, bounded history access, and the prohibition on older binaries writing migrated branches. Archive scan/page/cache numbers remain implementation targets to validate, not shipped guarantees.

### Implemented internally

`src/evidence/working-set.ts` adds pure functions and strict v2 envelope prototypes, with no runtime imports or registration:

- `legacyWorkingSet`: detached projection with deterministic `legacy:<sha256>` identity from a caller-supplied stable session/ancestry identity. Preserves invalid-event counts and exact records. Runtime still must choose/test the identity mapping for reload, forks and clones.
- `previewRollover`: explicit roots, full semantic `refs` closure including inactive support, original insertion order, exact record fields and qualified origin/replacement locators. Replacement ancestors are not recursively copied. Repeated rollover links to the immediate predecessor and retains earlier replacement locators where needed.
- `validateRollover`: recomputes the exact snapshot from the predecessor and checks preview token, anchor, selection, content and metadata. No caller-supplied snapshot is accepted merely for passing its schema.
- `applyScopedEvent`: detached reduction scoped to set, predecessor anchor and projection digest. Uses the unchanged v1 reducer, then validates local relationships and live budgets. This is not append, idempotency, branch authorization or persistence recovery.
- Both schemas reject unknown fields at envelope/record/source/locator levels and unknown outer versions. v1 writes are invalid input to the v2 scoped reducer; the runtime has not yet implemented mixed-history detection/read-only handling.
- Carry budgets are 256 records / 2 MiB serialized UTF-8 event data. Live limits remain 512 total, 32 active file records and 128 retained automatic records. Empty selection is explicitly represented and warns that omitted work is not resolved. Preview reports omitted active IDs, reviewed IDs, capacity, bytes, receipt exhaustion and incomplete legacy provenance.
- SHA-256 canonicalization sorts object keys lexically, preserves array order, and follows JSON omission for undefined optional properties. Digests do not assert truth or replace branch reachability checks.

Tests in `tests/evidence-working-set.test.ts` cover full-ledger recovery followed by correction, immutable predecessor state, inactive support, resolved gaps, repeated rollover lineage, canonical hashing, stale/altered previews, exact 256 closure limit, UTF-8 byte limits, file/receipt budgets, frozen v1 fixture round-trip, strict envelopes, wrong set/anchor, stale updates and invalid/cyclic dependencies.

### Intentionally unchanged / unfinished

- The extension still uses `src/evidence/model.ts` and v1 persistence. No sessions are migrated and the live 512-record capacity problem remains.
- Legacy `refs` and review prose are retained exactly. Structured review categories and explicit concern/resolution relationships belong to 1B/1C; no missing legacy meaning is guessed here.
- The v1 schema permits extra fields that strict v2 cannot interpret. Migration of such projections refuses rather than silently normalizing away unknown content. This does not change v1 reading.
- These pure functions accept trusted predecessor projections. Runtime must prove active-ancestry membership of every accessed locator and enforce unique set/operation IDs; a valid locator shape or digest is not authorization.
- Runtime must decide/test bounded cold replay and historical snapshot validation, including when predecessor reconstruction is required. The model's exact-transition check alone is not a bounded cold-replay implementation.
- Before exposing the feature: implement queued preview/commit, passive-event ordering, cancellation/session-generation checks, fail-closed malformed/future/mixed history, uncertain append recovery, disk reopen tests, bounded archive lookup/cache/cursors, fork/clone mapping, result/renderer compatibility, and README/release downgrade guidance.
- Internal previews contain bounded arrays/snapshot data for validation, not a public result contract. Runtime must paginate records (default 10/max 20) and summarize omitted IDs, never return the whole snapshot implicitly.

Validation and resumable next steps are recorded in root-plan Handoff 003. Phase 1A is **in progress**, not complete.

## 11. Phase 1A follow-up — public-session adapter

`src/evidence/session-store.ts` now supplies an internal adapter around Pi 1.2.0's public session reads and the extension append callback. It remains unimported by `src/evidence/index.ts`; the live tool still reads and writes v1 only.

### Replay and identity

- `EvidenceBranchReplay` walks parent pointers on the selected ancestry in resumable pages of at most 2,048 inspections and refuses ancestry beyond 8,192 entries. Collection and replay are both charged to the page budget. Incomplete cursors are not writable projections.
- Legacy identity uses the earliest v1 evidence entry ID and timestamp. If no v1 entry exists, it uses the root entry ID and timestamp. Session headers are deliberately excluded because fork and branch extraction replace them.
- Replay reconstructs the full predecessor projection before validating each v2 transition. It enforces unique operation IDs and working-set IDs across the ancestry. Malformed/future v2 envelopes, missing parents, stale branch movement, altered transitions, duplicate IDs, and v1 writes after migration are read-only failures.
- Pi forks and ordinary branch extraction retain entry IDs and timestamps, so identity and projections survive persistent reopen, fork, and clone tests. Pi branch extraction removes label entries and rechains retained children; if a label was the exact evidence predecessor anchor, replay detects the changed parent and fails closed. It does not guess a replacement anchor.

### Archive access

- `EvidenceArchiveReader` first proves that a requested anchor is on the active branch, then reconstructs its projection through the same strict replay path. Knowing a sibling entry ID is insufficient authorization.
- Continuations are process-local and branch-bound. At most two projection cursors are retained with LRU eviction; branch movement expires a cached continuation. Pages return at most 20 records and validate the set ID, anchor, and projection digest before exposing data.
- This bounds Midnight's added replay/projection memory. It does not make Pi's loaded session tree constant-size, and a successful historical projection says nothing about current source freshness.

### Commit and uncertain append recovery

- `EvidenceSessionStore` checks a writable full-branch replay, exact current leaf, operation/set uniqueness, cancellation, preview token, and detached next projection before invoking one synchronous append callback. No await or retry occurs across the commit boundary.
- On normal return, public session reads must show the exact expected custom entry as the new leaf and exact predecessor child before the adapter returns the next projection.
- Every thrown append is uncertain, including one where no matching in-memory entry is visible, because durability cannot be inferred from the exception. The adapter records whether the exact event is currently visible, locks all further writes, and never retries or rolls back.
- Recovery is explicit. It accepts only a fresh writable replay whose target anchor and captured branch leaf both equal the manager's current leaf. An archive replay, malformed branch, or stale branch cannot unlock writes.
- This is a logical replay boundary, not an fsync guarantee or filesystem transaction. A failed persistent append can leave an in-memory event that disappears after reload; recovery reports the branch Pi actually exposes and does not rewrite raw JSONL.

`tests/evidence-session-store.test.ts` covers bounded migration/scoped replay, archive pagination/LRU, sibling denial, persistent reopen, fork/clone/root identity, label-anchor clone failure, malformed/future/mixed/duplicate history, scan limits, stale and aborted commits, and append exceptions before and after in-memory mutation. These tests validate infrastructure, not a shipped migration path.

Final adapter-slice validation passed: the three evidence suites reported 39/39 tests; `npm run check` exited 0; and `npm test` exited 0 with 162 total, 161 passed, 0 failed, and 1 checkpoint test skipped because symlink creation was unavailable on this host. Full-test log triage was local, scanned all 174 lines, and made no provider request. Root-plan Handoff 004 records exact commands, hygiene, and remaining gates.

### Remaining release gates

Before importing this adapter into the live runtime: serialize v1/v2 and passive writes under one queue; bind operations to runtime generation/session replacement; define public preview, commit, recovery and archive result schemas with bounded output; preserve v1 saved-result rendering; add runtime cancellation and passive-interleaving tests; document the old-writer prohibition in README/release notes; and complete relevant manual/runtime compatibility gates. Structured review and relationship semantics remain Phase 1B/1C rather than being inferred during migration.

## 12. Phase 1A follow-up — internal queued runtime and bounded results

`src/evidence/runtime-v2.ts` now supplies an internal integration harness around the adapter. `src/evidence/result-v2.ts` defines its strict result schema. Neither is imported or registered by the live extension; existing v1 tool/command behavior is unchanged, and this is not a shipped migration path.

### Queue, lifecycle, and commit behavior

- Reads, previews, explicit updates, recovery, archive access, and v2 passive receipts/review writes use one FIFO queue. Passive extraction retains bounded receipt metadata, not command strings or tool output. Legacy passive writes and source capture/check are not connected yet.
- Each queued operation captures its session binding and generation. Stop/start aborts old work, clears projections/previews/archive cursors and passive call tracking, and rejects stale results/publication. Session replacement cannot publish an old generation's result.
- Caller cancellation before append prevents the write. Cancellation after a verified successful append returns committed state with `cancelledAfterAppend`; it does not pretend to undo the append. Generation replacement still suppresses the old result.
- An uncertain append stays locked across stop/start for the same manager/session. Only explicit fresh-replay recovery unlocks it. There is no retry, rollback, raw-session rewrite, or new durability guarantee.

### Bounded result contracts

- The closed schema discriminates list, preview, commit, update, recover, and archive results. Record pages default to 10 and allow at most 20; omitted-active and review ID lists are separately paginated. Results expose preview identity, counts, bytes, warnings and predecessor locator, never the full snapshot event. The follow-up in section 13 separates archive results from live metadata and uses nullable archive totals when unavailable.
- A preview is cached for an unchanged selection, anchor and projection digest so subsequent pages retain the token. Commit still validates against current branch state. Omitted records are archived, not resolved; carried observations are not freshly captured.
- The internal builder type uses optional variant fields; every return/publication is checked against the discriminated schema. Saved-result renderer support and public tool registration remain pending.

### Scan and memory qualification

The harness caches one live projection and one preview; the archive reader retains at most two projection cursors. At Handoff 005, unchanged leaves avoided replay, but moved leaves replayed cold and archive calls performed unreported live synchronization before the reader step. Those two internal gaps are addressed by section 13/Handoff 006. Live list/preview/check synchronization can still consume multiple 2,048-inspection pages, yielding between pages; only archive calls have the total one-page call budget. Neither bound makes Pi's whole loaded session tree constant-size.

### Validation and remaining integration

`tests/evidence-runtime-v2.test.ts` adds six scenarios for capacity recovery/historical pagination, passive FIFO ordering and stale previews, cancellation before/during queued work, generation replacement, post-append cancellation and explicit uncertain recovery, and branch movement/mixed-history refusal. Focused tests passed 6/6. Final `npm run check` exited 0 after fixing a test-only action-narrowing error; final `npm test` exited 0 with 168 total, 167 passed, 0 failed and 1 checkpoint symlink test skipped because symlink creation was unavailable on this host. Test-log triage was local, made no provider requests, and matched the original totals. Root-plan Handoff 005 records commands, timing and hygiene.

Phase 1A remains **in progress**. Section 13 closes the internal scan gates. Next integrate legacy/passive and file capture/check/navigation review paths under the shared queue, preserve saved v1/v2 result rendering, and document downgrade/old-writer restrictions in README/release notes before registering any v2 write. Relevant runtime/manual compatibility checks remain pending; no UI/provider/live/benchmark/install/packaging validation was run. Phase 1B/1C semantics remain out of scope.

## 13. Phase 1A follow-up — incremental live replay and total archive-call work

The harness now passes its trusted same-manager/generation projection into replay. Collection walks from the current leaf to the exact cached leaf, then replays only those descendants on a detached accumulator. Unchanged leaves still do no entry reads. If the cached leaf is not an ancestor (including navigation to a sibling, ancestor, or new root), replay reconstructs cold without mixing projections. Explicit uncertain-append recovery always reconstructs fresh, ignoring the cache.

Projection metadata includes ancestry length so an incremental delta cannot reset the 8,192-entry cap. Append preflight refuses to cross that cap, rather than producing a cached writable branch which a cold reader cannot reconstruct. Empty-root seeds preserve the earliest-v1 identity rule when the first evidence event arrives. Operation/set uniqueness, strict v2 transition checks, mixed-writer refusal, original record/review semantics, and invalid-event counts continue across seeded replay. The seed is a trusted internal projection, not a caller-authenticated snapshot or authority to read another branch.

Archive calls now run **without live synchronization**. Authorization, collection and replay are charged to one step of at most 2,048 actual `getEntry` reads per call, including the finishing step on success or locator mismatch. Root identity is captured during collection; root/failure handling no longer adds hidden reads. Authorization and target ancestry share the 8,192-entry cap. A cold scan returns a process-local continuation until complete; branch movement expires it, and at most two LRU cursors remain retained.

Archive results deliberately omit live summary, mode, writable state and append-lock metadata: historical lookup does not establish live freshness or perform live synchronization. They contain bounded historical records and archive progress/identity; `total` is `null` while unavailable, not a guessed zero. No records are exposed until ancestry, transitions and locator digest are validated. This adjusts only the unregistered internal v2 result contract; saved v1 results and shipped runtime behavior are unchanged.

Two additional runtime scenarios count actual public entry reads on cold/warm/descendant/navigation paths and cold archive continuations, completion, locator mismatch and expiry. Existing adapter cases additionally cover first-evidence identity from an empty seed, seeded full-ancestry limits, combined archive ancestry limits, append preflight, and exact read accounting on failure. Focused validation passed 18/18 before the last cap safeguards. Final `npm run check` exited 0 (85 files and TypeScript), and `npm test` exited 0 with 170 total, 169 passed, 0 failed, and 1 checkpoint symlink case skipped because host symlink creation was unavailable. Full-test triage ran locally over 182 lines, made 0 provider requests, and matched original totals; command exit codes were independently captured. Root-plan Handoff 006 records timing and hygiene. No code changed after final validation; no live/UI/provider validation was run.

Phase 1A is still **in progress**. These are internal infrastructure tests, not proof of live extension integration or a released capacity fix. Section 14 advances the internal legacy/passive and file capture/check/navigation gate; lifecycle/tool/command wiring, saved-result rendering, downgrade documentation, and relevant runtime/manual compatibility remain open.

## 14. Phase 1A follow-up — legacy/passive and source-I/O serialization

The unregistered runtime now accepts existing request parameters through its own FIFO, rather than calling the live v1 runtime's separate queue. Before explicit migration, validated writes preserve the original `midnight-evidence-v1` envelope. The session adapter applies them to a detached ledger and strict projection before append, verifies the expected custom type/parent/payload afterward, and locks uncertain writes after a thrown or unverifiable append. The first evidence entry supplies the stable legacy identity. No operation IDs are inserted into saved v1 events; a successful legacy result uses the verified entry ID to identify its append. Explicit fresh recovery is still required to unlock, with no retry/rollback or fsync guarantee.

Source capture/check defaults to the unchanged project-bound, sensitive-path/symlink-aware, UTF-8 readers and existing size/excerpt limits. Injectable I/O permits deterministic offline races. Every capture or check read is followed by cancellation, generation/session and exact branch-leaf validation before publishing or writing. Checks hash each unreviewed tracked path once, collecting reads before any review writes; a failed read is unavailable, not clean. Changed/unavailable observations preserve original hashes/excerpts and use unchanged v1 dependency semantics. Matching bytes, restore, reload and rollover never automatically clear review. A cancelled check after a verified review append stops further writes and reports the committed prefix with `cancelledAfterAppend`, not rollback or a completed whole check. Other persistence failures still throw/lock and are not an atomic multi-event transaction.

Passive review/receipt writes now use the same queue in legacy and v2 modes, retaining record/file/receipt limits. Internal list/ID/filter requests remain bounded (default 10/max 20). The strict v2 result union adds a check action, without changing saved v1 results or the shipped tool schema. Rollover still carries observations without recapturing sources or promoting interpretations.

Lifecycle start/restart only schedules conservative current-claim review; it performs no immediate source I/O or append. Queued live synchronization applies and publishes that review. Navigation wiring must call `start` even when returning to a previously visited descendant: public parent pointers cannot distinguish that from new append-only descendants. A non-ancestor cold replay also schedules review as a fallback. Historical claims are not silently promoted or freshness-reviewed, and existing review prose remains retained. Archive calls still skip live synchronization and keep their total one-page inspection budget. Post-append generation guards suppress old publication/results and prevent seeding a replacement manager with the old projection.

Three grouped runtime scenarios cover FIFO legacy capture/receipts and migration, deduplicated checks/missing/restored sources/committed cancellation prefixes in both modes, and source-I/O cancellation/replacement/branch races with deferred navigation. The existing uncertain-append scenario covers legacy failures before/after mutation, explicit recovery and append-time replacement. The first focused run failed because the navigation fixture omitted the required lifecycle hook; the corrected fixture and added assertions pass 21/21. Final `npm run check` exited 0 (85 files, then TypeScript), and `npm test` exited 0 with 173 total, 172 passed, 0 failed, and 1 checkpoint symlink case skipped because host symlink creation was unavailable. Auto triage ran locally over all 185 log lines, made 0 provider requests, and matched original totals; actual command exits were captured independently. Root-plan Handoff 007 records timing and hygiene. No code changed after final validation; no live/UI/provider validation was run.

This completes another **internal** Phase 1A slice, not live integration. Saved-result rendering, downgrade/old-writer documentation, lifecycle/tool/command wiring, and relevant runtime/manual compatibility remain release gates. The live extension still uses its original v1 runtime, including the known capacity defect; Phase 1B/1C semantics remain out of scope.

## 15. Phase 1A follow-up — saved-result presentation and downgrade guidance

Handoff 008 adds a pure compact formatter for saved v1 summaries and strict v2 results. It distinguishes preview-only output, committed writes and cancellation after append, a cancelled check's committed prefix, uncertain append locks, read-only/issue/capacity states, and historical archive scans or unavailable results without inventing zero totals or live freshness. Unknown/malformed versions use ordinary fallback output. Normal and error rows use the formatter; expanded/disabled rendering preserves original saved/model-facing results. No source checks, replay, archive scans or provider calls occur in rendering.

Frozen synthetic saved-result details and grouped renderer tests cover v1/v2 compatibility, v2 actions and state warnings, fallback, narrow Unicode widths, error rows and nonmutation. Final focused tests passed 11/11; `npm run check` exited 0; `npm test` exited 0 with 175 total, 174 passed, 0 failed and 1 checkpoint symlink skip due to host limitations. Local auto triage made 0 provider requests (41 ms total, 0 ms provider wait). See root-plan Handoff 008 for the corrected invalid preview fixture and exact validation/hygiene details.

README and `docs/releases/unreleased.md` now explain the old-writer prohibition, passive-write hazard, isolation of experimental migrated sessions, and absence of automatic downgrade/merge/repair. No released safe v2 writer is claimed. This change does not register the v2 runtime or expose rollover: live v1 capacity behavior remains unchanged. Lifecycle/tool/command wiring and relevant runtime/manual compatibility gates remain open; no manual UI or provider validation was run.

## 19. Current development boundary — workflow and advisory audit

Handoff 014 completes the selected workflow/audit development slice. `/skill:midnight-evidence` is explicit-only and discovered by the existing package skills path. It guides gap selection, inspected evidence, revision and honest stopping. Skill loading does not prove model compliance or reasoning benefit; neither is claimed.

The public `audit` action accepts 1–20 selected claim IDs, pages at most 20 findings, and attempts at most 32 distinct bounded file hashes. It reports selected structural support, linked concerns and resolution evidence, review/lifecycle limitations, receipts and legacy relationship ambiguity. Unrelated gaps are excluded. Cold replay and source reads use the shared FIFO with cancellation/session/branch guards, but bypass lifecycle synchronization, initialization, writes and publication. Each page call is a new observation. Read-only/locked state is unavailable; zero findings is not semantic verification or proof that no unrecorded uncertainty exists.

Two grouped runtime regressions and an extended registration case use existing harnesses; the Pi loader confirmed explicit-only discovery without provider calls. Full tests exited 0 (189 total, 188 passed, 1 host symlink skip); final check exited 0 (92 files) after an erased test-only nullable type correction. Auto triage was local with zero requests (36 ms total, zero provider wait). See Handoff 014 for exact validation boundaries. Stop implementation at this selected scope: manual fullscreen/reload compatibility remains a release blocker, model benefit unmeasured, optional roadmap work deferred.

## 18. Current development boundary — fresh-session v3 semantics

Handoff 013 connects the semantic reducer through live registration, initialization, persistence/replay, tool results, rollover and archive. D12 permits new sessions only: Pi's explicit `new` event with no preexisting conversation entries initializes v3. Startup/reload/resume/fork do not upgrade existing history; persisted v3 still survives reload/fork. An empty ledger alone is not proof of freshness. V1/v2 event schemas and hashes remain unchanged, and mixed writers/semantic upgrades are refused.

V3 stores eight structured review causes with sticky overflow; checks retain review after restore and avoid duplicate reason appends. Claims keep support refs; gaps preserve separate concerns and resolution support, with refs as their bounded dependency union. Carry-forward preserves both relationships and review. Public concerns/resolvedBy are rejected on old sessions; refs remain compatible aliases for v3 gap-add/resolve. Show/results expose reasons and relationships. Initialization failure never silently retries or falls back to legacy writes within the runtime; confirmed recovery validates only visible valid history.

Two grouped registration cases extend the existing harness, covering the live relationship/source/rollover/archive path, persistent reopen/fork, legacy modes and initialization failure. Final focused tests passed 42/42; check exited 0 (91 files); full tests exited 0 (187 total, 186 passed, 1 host symlink skip). Auto triage local, zero provider attempts, 78 ms total / zero provider wait. See Handoff 013 for exact logs and scope. This completes the requested development integration, not release certification: manual fullscreen/reload compatibility remains an explicit blocker. Opt-in skill and advisory audit remain separate milestone deliverables.

## 17. Current development boundary — user-confirmed capacity recovery

Handoff 010 exposes preview and bounded archive lookup through the tool, while commit and append-lock recovery are command-only and require idle interactive TUI confirmation. The user explicitly selected this authorization boundary. No automatic migration or model-callable commit/recovery exists. Preview accepts explicit selected IDs (including deliberate empty selection), preserves dependencies/review and enforces 256 carried records / 2 MiB. Archive accepts the predecessor locator or branch-bound continuation, retaining scan/page limits and unknown totals while unavailable.

The confirmation shows carry/omission/review counts and old-writer warnings; declined, busy, noninteractive, concurrent, stale-session and moved-branch cases cannot authorize a commit. Recovery only validates fresh replay before unlocking; it never retries or undoes an append. Dialogs coordinate with question/triage ownership and close file previews. Old v1 writers remain prohibited on migrated branches.

Final check exited 0 (90 files); full tests exited 0 with 183 total, 182 passed and 1 host symlink skip. Focused registration/panels passed 17/17. Local auto triage made 0 requests (47 ms total, 0 provider wait). Handoff 010 records exact validation and inherited-work hygiene. Manual fullscreen/reload compatibility remains an unverified release blocker; development controls and mocked tests are not proof of release compatibility. No manual UI/provider validation was performed.

## 16. Phase 1A follow-up — live bridge for existing operations

Handoff 009 connects `src/index.ts` to `src/evidence/register.ts`, registering the shared runtime for existing tool actions and status/check/show commands. Lifecycle load/navigation initializes and refreshes it; source checks and passive observations use its FIFO, and shutdown/session generation guards discard stale work. New tool results are version 2 with wrapped record pages and writable/append-lock metadata. Legacy storage remains v1 until explicit migration. Public rollover, archive and recovery operations are not exposed; ordinary capacity recovery remains unavailable.

A presentation-only `EvidenceDisplaySummary` marks loading, unavailable checks, interrupted checks and read-only history without inventing clean counts. Saved-result rendering stays unchanged. Navigation review interrupted after a verified append reports committed work and leaves remaining review pending; it does not claim rollback or complete review. The original runtime remains for characterization/shared definitions, not live registration. Compatibility warnings now distinguish pre-bridge writers from the new development runtime; no released safe-v2-writer claim or automatic downgrade/repair is made.

Six registration tests and the sidebar regression cover bridge schema/storage, FIFO/passive/lifecycle paths, source change/restore, malformed history, cancellation/uncertain append and replacement. Focused tests passed 26/26. Full tests exited 0 (181 total, 180 passed, 1 host symlink skip); final check exited 0 after correcting an erased test-context type. Auto triage was local with 0 provider requests (34 ms total, 0 ms provider wait). Root-plan Handoff 009 records failures/corrections and exact validation boundaries. Public rollover and relevant runtime/manual compatibility gates remain open; no manual UI/provider checks were run.
