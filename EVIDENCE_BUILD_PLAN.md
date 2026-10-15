# EVIDENCE improvement build plan

> **Living implementation plan.** Use this file as the shared checklist and handoff record across sessions. Work through the phases iteratively; do not treat this roadmap as authorization for provider calls, paid evaluations, or unrelated changes.
>
> **Current status:** Phase 0 complete. Phase 1A development controls now expose bounded preview/archive inspection and user-confirmed rollover/append-lock recovery (Handoff 010), on the shared queued runtime. The model cannot commit or recover; those commands require an idle interactive TUI confirmation. Legacy storage stays v1 until explicit migration. Automated public-registration capacity recovery passes; manual fullscreen/reload compatibility remains an unverified release blocker. Phase 1A is not release-complete. Phase 1B/1C live development integration is complete for explicitly new sessions (Handoff 013); old sessions are not upgraded.
> **Next action / stop:** Handoff 014 completes the selected milestone's development implementation with the explicit-only investigation skill and read-only advisory audit. Stop adding features. Manual fullscreen/reload compatibility remains an unverified release blocker; model/workflow benefit remains unmeasured. Existing-session upgrades and optional roadmap work remain deferred. Obtain separate authorization before manual/provider validation.
>
> **Phase 0 specification:** [`docs/evidence-phase-0.md`](docs/evidence-phase-0.md) contains the verified baseline, lifecycle table, compatibility policy, bounded working-set proposal, and future test matrix.

## 1. Goal

Evolve Midnight's local evidence ledger into a reliable, opt-in investigation workflow:

> Identify what could change the answer → gather the relevant observation → revise the conclusion → check whether anything material remains unresolved → answer with appropriate scope and uncertainty.

The goal is not to accumulate more records. It is to reduce stale conclusions, unsupported answers, and investigation that does not resolve decision-changing uncertainty.

The reference is [LongHarness: Advancing Agentic Reasoning over 100M-Token Corpora via Stateful Evidence Management](https://arxiv.org/pdf/2610.13075). `README.md` already identifies it as the ledger's inspiration. Midnight is an adaptation for coding investigations, not a reproduction of the paper's complete harness or its benchmark results.

### Three implementation layers

1. Make the ledger reliable throughout a long investigation.
2. Add an explicit workflow that actually uses the ledger.
3. Evaluate whether that workflow improves answers, not merely whether storage works.

### What success means

| Property | Intended assurance |
| --- | --- |
| Provenance integrity | A record points to the observation it was created from. |
| Lifecycle integrity | Corrections, retractions, and dependency changes remain consistent. |
| Workflow discipline | The agent investigates important gaps and reassesses conclusions. |
| Semantic correctness | The conclusion actually follows from evidence and answers the question; this remains a reasoning and evaluation responsibility. |

Do not confuse these properties:

- Active references do not prove a conclusion true.
- No recorded gaps does not mean all relevant uncertainties were discovered.
- A matching hash does not establish correct interpretation.
- Exit code zero does not establish implementation correctness.
- A passing fixture does not establish production or UI compatibility.
- The paper's benchmark improvements are not evidence of Midnight's benefits.

## 2. Baseline and already verified findings

These findings describe the review preceding this plan. Recheck relevant assumptions when implementation resumes; they are not fresh validation of future code.

- [x] Confirmed the README explicitly cites LongHarness.
- [x] Reviewed `src/evidence/model.ts`, `src/evidence/source.ts`, and `src/evidence/index.ts`.
- [x] Compared the implementation with the paper's core mechanism and runtime specification.
- [x] Ran `node --experimental-strip-types --test tests/evidence.test.ts`: 13 tests passed, 0 failed, exit code 0.
- [x] Reproduced correction failure at 512 retained records: supersession is rejected at capacity, and retracting a record does not free capacity.
- [x] Established that the current implementation is a ledger, not the full gap-driven investigation loop.
- [x] Created this implementation plan and checklist.

### Existing strengths to preserve

- Branch-local, append-only session events and replay.
- Source-linked file excerpts and original-byte hashes.
- Bounded local reads: 1 MiB files; excerpts up to 100 lines / 4,000 characters.
- Project-boundary, symlink-target, sensitive-path, and UTF-8 checks.
- Claims referencing active evidence.
- Supersession/retraction without erasing historical records.
- Dependency review and reopening of gaps when supporting evidence is invalidated.
- Historical versus current applicability.
- Conservative review after observed shell/edit/write completion and session/tree transitions.
- Tracked-file checks at agent completion, compaction, and explicit check.
- Passive shell and advisory triage receipts without copying command strings or output.
- Serialized explicit operations, cancellation, and stale-session handling.
- No ledger-driven prompt injection, provider calls, uploads, or background reasoning.

### Known limitations and findings

| Finding | Classification | Planned response |
| --- | --- | --- |
| 512 retained-record cap prevents further supersession, even after retraction | Confirmed lifecycle problem | Phase 1 bounded working sets and explicit rollover |
| Agent can ignore the ledger and its gaps | Workflow gap | Phase 3 opt-in investigation skill |
| Normal final answers are not structurally audited against evidence | Workflow gap | Phase 4 selected-claim audit |
| Hypotheses and established conclusions share one claim type | Representation limitation | Phase 1 maturity semantics; Phase 5 presentation |
| Receipt count can be mistaken for substantive evidence coverage | Presentation/interpretation limitation | Phase 2 separate counts and explicit test evidence |
| All-shell and whole-file invalidation can cause review noise | Deliberate conservative behavior | Structured reasons first; better diagnostics without automatic clearance |
| Reasoning benefit has not been measured | Evaluation gap | Phase 6 scenarios and separately approved model evaluation |

Local review artifacts may exist in `.artifacts/evidence-review/`. They are ignored, optional, and not portable evidence for future sessions. Re-read authoritative source files; do not depend on those artifacts being present. The paper PDF remains the external reference.

## 3. Non-negotiable constraints

- [ ] Preserve local-only evidence operations: no provider calls or uploads introduced by bookkeeping or audit.
- [ ] Keep investigation workflow opt-in; ordinary small edits must not require formal evidence administration.
- [ ] Do not automatically execute proposed checks or resolve gaps semantically.
- [ ] Do not rewrite saved conversation history or silently delete provenance.
- [ ] Do not capture secrets, environment values, full commands, or full output by default.
- [ ] Preserve bounded source reads, output pagination, and project-boundary protections.
- [ ] Keep filesystem work asynchronous and outside rendering; no ordinary-refresh polling or recursive watchers.
- [ ] Preserve cancellation and discard stale results after reload, session replacement, and shutdown.
- [ ] Branch navigation must not restore files or imply current filesystem validity.
- [ ] Never present unknown, unavailable, or stale evidence as clean.
- [ ] Keep native context management responsible for context retention; do not create a competing context owner.
- [ ] Keep existing persisted records readable through explicit versioned compatibility handling.
- [ ] Use public Pi APIs where available; do not change pinned Pi dependencies for this task.
- [ ] Do not claim independent semantic verification.
- [ ] Obtain explicit approval before live/provider evaluation, paid benchmarks, or broadened data uploads.
- [ ] Preserve unrelated and pre-existing repository changes.

Recheck this list before closing each phase. These are ongoing invariants, not features that become permanently verified after one checkmark.

## 4. How to use this plan between sessions

### Start-of-session checklist

- [ ] Read this plan's current status, decision log, and latest handoff.
- [ ] Inspect `git status --short` and preserve unrelated work.
- [ ] Read current relevant source/tests rather than relying on old line numbers or summaries.
- [ ] Select one coherent phase slice; write its scope and acceptance criteria in the handoff log.
- [ ] Check whether an unresolved decision materially changes compatibility, privacy, cost, or behavior; ask before implementing that decision.
- [ ] Read relevant Pi documentation if the slice changes Pi APIs, persistence integration, tools, skills, or UI behavior.

### End-of-session checklist

- [ ] Update completed task boxes only when the corresponding work and verification are complete.
- [ ] Record changed files and any pre-existing work that must be preserved.
- [ ] Record exact validation commands, actual exit codes, pass/fail/skip totals, and unrun checks.
- [ ] Record design decisions and reasons, including rejected approaches worth remembering.
- [ ] Record remaining uncertainty, failures, and unfinished work.
- [ ] Set one concrete next action and update the status near the top of this file.
- [ ] Keep generated logs/artifacts out of version control; do not store secrets in the plan.
- [ ] Do not describe a phase as complete while its acceptance gates remain unmet.

### Status vocabulary

Use `not started`, `designing`, `implementing`, `validating`, `blocked`, or `complete` in the phase table. A task checkbox records completion, not intention. Split partially completed tasks rather than checking them prematurely.

## 5. Phase overview

| Phase | Deliverable | Status | Main dependency |
| --- | --- | --- | --- |
| 0 | Baseline, lifecycle specification, regression scaffolding | Complete | None |
| 1 | Reliable bounded lifecycle, structured review, relationship/maturity semantics | Development integration complete for selected scope; manual release gates open; maturity deferred | Phase 0 |
| 2 | Useful evidence distinctions and freshness diagnostics | Not started | Phase 1 model decisions |
| 3 | Opt-in gap-driven investigation skill | Implementation complete; explicit-only discovery validated, model benefit unmeasured | Stable ledger operations |
| 4 | Explicit selected-claim pre-answer audit | Implementation complete; deterministic regressions pass | Phase 1 semantics and Phase 3 workflow contract |
| 5 | Discoverability and UI | Not started | Stable tool/result schemas |
| 6 | Deterministic scenarios and benefit evaluation | Not started | Tests begin in Phase 0; behavioral evaluation follows workflow |

The roadmap is iterative, not a requirement for one large release. Use the first milestone in section 13 to limit the initial delivery.

---

## 6. Phase 0 — baseline and lifecycle specification

### Purpose

Turn the review findings into explicit, testable contracts before changing persistence or behavior.

### Tasks

- [x] Recheck the current implementation, existing tests, README, and repository state.
- [x] Capture the capacity failure as a regression fixture with a defined desired recovery path.
- [x] Inventory record/event schemas, result schemas, branch replay, cancellation, UI consumers, and context boundaries.
- [x] Write a transition table for active, superseded, retracted, resolved, and review-required records.
- [x] Define the effects of source change, source unavailability, dependency correction, retraction, branch change, and reload.
- [x] Specify how current versus historical applicability interacts with each transition.
- [x] Specify gap concerns separately from evidence that resolves a gap.
- [x] Identify legacy compatibility fixtures and malformed-event behavior.
- [x] Design the capacity solution before changing the record limit.
- [x] Agree on the first milestone's included versus deferred work.

Delivered in `docs/evidence-phase-0.md`, five additional characterization tests in `tests/evidence.test.ts`, and the frozen `tests/fixtures/evidence-v1.json`. Capacity recovery itself is not implemented. The proposed representation, limits, and compatibility interaction require review before Phase 1A implementation.

### Acceptance criteria

- [x] Every lifecycle transition has an expected outcome and relevant test location.
- [x] The bounded working-set proposal explains storage, replay, origin references, cancellation, and historical retrieval.
- [x] Schema evolution and legacy behavior are explicit.
- [x] No source changes are justified solely by assuming the paper's runtime should be copied unchanged.

These are specification gates, not claims that all future acceptance tests pass. Unimplemented v2 scenarios remain unchecked in the Phase 0 specification's test matrix.

---

## 7. Phase 1 — reliable ledger lifecycle

### 1A. Capacity recovery with bounded working sets

**Problem:** all retained records count toward 512; supersession creates a record; retraction does not reduce the retained map. A full ledger cannot record a corrected replacement.

**Recommended direction:** separate the active investigation working set from historical provenance retained in session history. Provide explicit rollover, not silent deletion or unbounded growth.

A rollover should:

1. Select still-relevant conclusions and open gaps.
2. Include their required evidence/dependency closure.
3. Retain links to their origins.
4. Preserve review status, applicability, and uncertainty.
5. Leave historical records recoverable through bounded on-demand inspection.
6. Create space for continued investigation without pretending old observations were freshly captured.

Approved carry-forward identity direction (D10):

```text
Old set A:
  E12: earlier source observation
  C18: conclusion supported by E12; review required
  G23: unresolved question

New set B:
  E12: same recorded observation; origin A/E12 at predecessor anchor
  C18: same conclusion; support E12; review still required
  G23: same unresolved question
```

Record IDs stay stable; external locators qualify them by set and anchor. Unselected dependency ancestors are carried only when required by semantic refs; replacement lineage uses archive locators, not recursive copies.

#### Slice 1 — internal model (not a runtime release)

- [x] Obtain approval for explicit preview/commit, 256-record / 2 MiB carry bounds, and old-writer prohibition.
- [x] Prototype strict v2 snapshot/update envelopes and set-qualified origin/replacement locators.
- [x] Preserve stable IDs, record order, timestamps, source content, lifecycle and review state.
- [x] Compute exact semantic dependency closure, including inactive support; leave lineage in archive links.
- [x] Bind preview to selection, predecessor anchor and canonical projection digest; reject altered snapshots.
- [x] Enforce carry/live-file/receipt bounds and warn about omitted work, empty carry and incomplete legacy provenance.
- [x] Add isolated scoped updates using unchanged v1 lifecycle semantics and no I/O.
- [x] Add pure regression coverage including full-ledger recovery, Unicode byte bounds and frozen legacy data.
- [x] Complete final slice validation and record actual results in Handoff 003.
- [ ] Integrate with runtime; pure tests do not establish archive reachability, disk recovery or mixed-version replay safety.

`src/evidence/working-set.ts` is now a transitive dependency of the queued live runtime, but its rollover API remains internal and unexposed. Its envelopes retain v1 record semantics; structured reasons/relationships remain later slices. No automatic migration is performed.

#### Tasks

- [x] Finalize working-set identity and event schema against replay/fork/clone tests for the internal adapter.
- [x] Define dependency closure and selection rules, including resolved gaps needed as provenance.
- [x] Define bounded historical lookup semantics and limits without loading unlimited history on every operation/render.
- [x] Implement incremental replay and total per-call archive inspection budgets in the internal runtime; document cold-scan cost and continuations.
- [ ] Preserve those bounds and incremental branch handling when connecting the live extension.
- [x] Prototype with public Pi session APIs.
- [x] Validate the entire rollover before persisting its transition; use a coherent logical commit boundary.
- [x] Define behavior when the selected closure itself exceeds capacity.
- [x] Define and test internal cancellation/session replacement behavior before and during persistence, including source I/O and committed check prefixes.
- [x] Serialize internal legacy/passive writes, file capture/checks, and deferred navigation review in the shared queue.
- [x] Wire those guarantees through existing live lifecycle/tool/command paths after saved-result and downgrade compatibility work (Handoff 009); public rollover remains gated.
- [ ] Implement actionable near-capacity and exhausted-capacity diagnostics.
- [ ] Implement explicit rollover and bounded inspection of prior working sets.
- [x] Preserve origin identity and reject ambiguous/cross-branch archive access in the internal adapter.
- [ ] Update shipped documentation and compatibility behavior when runtime migration is exposed.

#### Rejected shortcuts

- Raising 512 without a lifecycle strategy only postpones failure.
- An unbounded supersession exemption removes the bound.
- A fixed correction reserve is a temporary mitigation, not a complete solution.
- Deleting old records destroys provenance.
- Carrying records forward as fresh evidence silently launders staleness.

#### Acceptance tests

- [ ] Near-capacity correction and explicit recovery work as specified.
- [ ] Exhaustion never claims successful capture or correction.
- [ ] Retraction behavior is explicit and does not falsely promise freed historical capacity.
- [ ] Old records and replacement chains remain inspectable.
- [ ] Required supporting evidence is not silently dropped.
- [ ] Review flags and historical applicability survive rollover.
- [ ] Oversized dependency closure is refused with a useful explanation.
- [ ] Cancellation/interruption does not expose a partial working set.
- [ ] Branch replay and reload reconstruct the intended working set.
- [ ] Legacy records remain readable.

### 1B. Structured review reasons

Introduce machine-readable reason categories with human-readable explanations. Suggested categories:

```text
source_changed
source_unavailable
dependency_superseded
dependency_retracted
possible_worktree_change
session_reloaded
branch_changed
legacy_unspecified
```

These categories describe why reassessment is needed, not whether a conclusion is false.

#### Tasks

- [x] Define reason schema and compatibility mapping (v3 for new sessions; unchanged legacy semantics).
- [x] Do not guess precise categories from ambiguous old prose.
- [x] Decide how multiple simultaneous reasons are retained/displayed within bounds (eight causes plus sticky overflow).
- [x] Preserve dependency propagation and historical/current distinctions.
- [x] Return actionable reason details in tool results and show command.
- [x] Test that review does not clear merely because a file is restored.

### 1C. Explicit relationship semantics

Distinguish:

- **Support:** evidence supporting a claim.
- **Concern:** the conclusion or question a gap is about.
- **Resolution support:** evidence used to close a gap.
- **Origin/replacement:** historical lineage.

Example:

```text
Gap G7:
  question: Does cancellation prevent late state updates?
  concerns: [C3]
  resolvedBy: [E9, E10]
```

This is a relationship-design improvement, not a claim that every existing use of `refs` is defective.

#### Tasks

- [x] Define which relationship types are needed in the first milestone.
- [x] Specify invalidation/reopening rules for each relationship.
- [x] Preserve concern links when recording resolution evidence.
- [x] Specify how supersession affects closed gaps and dependent conclusions.
- [x] Define bounded traversal and cycle rejection/defense.
- [x] Implement versioned compatibility for old `refs` without inventing lost semantics (new sessions only, D12).
- [x] Add regression coverage for replacement, resolution, reopening, and branch replay.

### 1D. Claim maturity

Proposed values:

- `hypothesis`: plausible supported interpretation with material uncertainty.
- `established`: agent-assessed conclusion adequately supported for its stated scope.

Neither means independent verification. Avoid numerical confidence percentages without calibration.

#### Tasks

- [ ] Define maturity separately from applicability, lifecycle status, and review status.
- [ ] Define conservative legacy behavior without silently promoting existing claims.
- [ ] Require references for supported hypotheses and established claims.
- [ ] Make promotion an explicit reassessment, never an automatic consequence of zero open gaps.
- [ ] Add filtering/result support and tests.
- [ ] Document terminology clearly.

### Phase 1 exit gate

- [ ] Capacity recovery works without losing provenance or freshness warnings.
- [ ] Review and dependency semantics are tested and documented.
- [ ] Legacy compatibility and branch/session cancellation tests pass.
- [ ] Relevant focused tests, final `npm run check`, and final `npm test` pass for the delivered changes.
- [ ] Any deferred maturity or relationship work is explicitly listed in the handoff and milestone scope.

---

## 8. Phase 2 — evidence quality and freshness diagnostics

### 2A. Separate receipts from substantive evidence

A shell exit receipt is useful provenance, but is not equivalent to a source observation supporting a behavioral conclusion.

#### Tasks

- [ ] Define separate summary counts for source observations and passive receipts.
- [ ] Derive distinctions from existing source/automatic metadata where possible; avoid redundant fields.
- [ ] Preserve receipt provenance, advisory status, actual structured exit codes, and parent call IDs.
- [ ] Ensure source counts do not imply semantic coverage or verification.
- [ ] Add summary/schema tests and update documentation.

### 2B. Explicit test evidence

Useful test evidence identifies:

- The tested behavior and assertions.
- The particular execution result.
- The observation's scope and relevant code state.
- The original receipt/report provenance.

Recommended first workflow:

1. Run the relevant focused test normally.
2. Preserve the actual execution receipt.
3. Explicitly capture a bounded result excerpt or structured report.
4. Link the conclusion to both the relevant assertions and the observed result.

Example:

```text
E1: Test asserts no publication after shutdown.
E2: The focused run reports that test passed.
C1: The tested late-publication scenario passes.
```

Do not expand C1 into “all shutdown behavior is correct.”

#### Tasks

- [ ] Document and test the explicit source-excerpt/report workflow first.
- [ ] Prefer dedicated parsers for structured reports when appropriate.
- [ ] Preserve actual exit-code provenance separately from report interpretation.
- [ ] Keep output bounded and project-scoped; avoid automatic full-output persistence.
- [ ] Do not capture credentials, environment variables, or command strings by default.
- [ ] Decide whether a dedicated test-evidence source type is justified after trying the simpler workflow.
- [ ] Record that decision and any deferred schema work.

### 2C. Better freshness explanations

Keep conservative invalidation initially. Consider diagnostics such as:

```text
File changed outside the captured excerpt.
Captured excerpt still matches.
Broader current applicability still requires reassessment.
```

An unchanged excerpt can behave differently after caller, import, configuration, dependency, or surrounding control-flow changes. Excerpt matching is not automatic review clearance.

#### Tasks

- [ ] Define which freshness distinctions can be established reliably within existing bounds.
- [ ] Handle moved/duplicated excerpts without pretending an ambiguous match establishes identity.
- [ ] Keep missing/unreadable sources explicitly unavailable.
- [ ] Avoid arbitrary-shell read-only classification.
- [ ] Add bounded freshness diagnostics only if they materially improve reassessment.
- [ ] Test that unchanged excerpt diagnostics do not silently clear claims.

### Phase 2 exit gate

- [ ] Receipts and source observations are distinguishable in structured output.
- [ ] Test evidence examples preserve narrow conclusions and real execution provenance.
- [ ] Freshness diagnostics do not weaken existing conservative guarantees.
- [ ] Relevant tests and documentation are complete; deferred optional enhancements are recorded.

---

## 9. Phase 3 — opt-in investigation workflow

### Purpose

Recover the paper's most important missing behavior without introducing a mandatory controller or ledger injection into every prompt.

### 3A. Add a focused evidence-investigation skill

Suitable tasks:

- Root-cause investigations.
- Architecture or compatibility reviews.
- Security-sensitive reasoning.
- Paper-to-implementation comparisons.
- Multi-file work with uncertain behavior.

Unsuitable triggers:

- Every rename, typo fix, or straightforward small edit.
- Requests where the ledger adds ceremony without decision value.

Ownership boundaries:

- EVIDENCE owns provenance and relationships.
- Context management owns retained working context.
- The coding model owns reasoning.
- Existing tools perform investigation and validation.

#### Tasks

- [x] Read Pi skill documentation and the skill-creator instructions when implementing the skill.
- [x] Define precise triggering and non-triggering guidance (explicit command only).
- [x] Describe current tools only; do not advertise unimplemented operations.
- [x] Add the investigation loop, revision step, and stopping conditions below.
- [x] Keep instructions portable and bounded.
- [x] Verify package skill discovery/documentation with Pi's local loader.
- [x] Verify explicit-only discovery and exclusion from automatic model advertisement. Model-use scenarios/effectiveness remain unevaluated; no provider calls authorized.

### 3B. Compact investigation state

Maintain:

```text
Goal
Decision or requested output
Scope boundaries
Current conclusions
Decision-changing gaps
Next useful check
Stopping conditions
```

The ledger stores durable evidence relationships. The context tracker stores a concise working summary and IDs, not duplicates of every excerpt.

Example:

```text
Goal:
Determine whether shutdown safely cancels pending evidence work.

Current conclusion:
Queued work appears cancelled; already-running work needs inspection.

Decision-changing gap:
Can an in-flight source read append after session replacement?

Next useful check:
Inspect generation checks and exercise replacement during a delayed read.

Stop when:
The relevant paths are covered, or remaining uncertainty is clearly disclosed.
```

#### Tasks

- [ ] Define how investigation scope and selected records are identified.
- [ ] Avoid a second competing tracker or independent context projection.
- [ ] Explain how to resume by inspecting recorded claims/gaps after a break.
- [ ] Explain how branch changes affect current applicability.

### 3C. Gap prioritization

Use a qualitative rubric, not fabricated numerical precision:

1. **Impact:** could this change the answer or recommendation?
2. **Discrimination:** would the next check distinguish plausible explanations?
3. **Cost:** can it be answered cheaply and safely?
4. **Dependency:** do other important conclusions rely on it?
5. **Authorization:** does it require permission or unavailable access?

#### Tasks

- [ ] Include examples of high-impact versus distracting gaps.
- [ ] Require a concrete next check for prioritized gaps where feasible.
- [ ] Defer unauthorized checks explicitly instead of executing them.
- [ ] Change query/reading strategy when a check is uninformative; do not repeat blindly.

### 3D. Revision after meaningful discovery

Ask:

- What conclusion does this support?
- What conclusion does it weaken?
- Does it contradict an earlier observation?
- Does a gap close or a new decision-changing gap emerge?
- Does the next investigation step change?

#### Tasks

- [ ] Require explicit correction/retraction when prior evidence or interpretation is wrong.
- [ ] Do not automatically rewrite conclusions from dependency changes.
- [ ] Keep evidence admission and subsequent conclusion use ordered around successful tool results.
- [ ] Require support for all decision-critical premises, not merely related evidence.

### 3E. Stopping rules

Stop when:

- The requested answer is supported within scope.
- Remaining gaps would not change that answer.
- A material gap cannot be resolved with available evidence.
- Further work requires permission, unavailable access, or disproportionate cost.

The last two produce qualified answers, not silent completion or endless exploration.

#### Tasks

- [ ] Include examples of legitimate qualified stopping points.
- [ ] Require disclosure of material unverified behavior.
- [ ] Do not require all unrelated session gaps to close.
- [ ] Distinguish “no remaining declared gap” from complete coverage.

### Phase 3 exit gate

- [ ] Skill is discoverable and only claims available capabilities.
- [ ] Workflow covers gap selection, source inspection, revision, and stopping.
- [ ] It preserves local-only bookkeeping and existing context ownership.
- [ ] Small tasks can proceed without evidence ceremony.
- [ ] Scripted workflow scenarios cover the main behaviors; empirical model benefit remains explicitly unproven until evaluated.

---

## 10. Phase 4 — selected-claim pre-answer audit

### Purpose

Provide an explicit structural and tracked-source freshness assessment before a substantial answer. Start advisory, not as a hard chat gate.

### Audit inputs and scope

Accept selected claims or an investigation scope. Do not require the entire session ledger to be clean.

An unrelated Windows UI gap should not block an answer about source-capture limits. An abandoned historical approach should not dominate a current audit.

### Deterministic checks

- Selected records exist on the active branch/working set under the defined historical-reference rules.
- Selected claims are active and their review status is reported.
- Supporting evidence exists and is active.
- Tracked file sources are available and unchanged, or their uncertainty is reported.
- Linked open gaps are identified.
- Capacity limits and invalid stored events that affect coverage are disclosed.
- Traversal, reads, and output remain bounded.

### Agent responsibilities, not deterministic guarantees

- Whether the evidence actually supports the conclusion.
- Whether historical claims are being misused to describe current behavior in the answer.
- Whether a gap is decision-changing for the user's request.
- Whether important evidence or gaps were never recorded.
- Whether the proposed answer matches the requested scope and format.

### Suggested output shape

```text
Reference integrity: valid
Tracked-source freshness: checked
Review-required claims: 1
Open gaps linked to selected claims: 1
Semantic support: not evaluated
Untracked external state: not checked
```

Never label the output “answer verified.” “Checked” must describe a bounded observation, not perpetual freshness or a transactional filesystem guarantee.

### Tasks

- [x] Specify audit input/output schemas and compatibility behavior.
- [x] Define selected-claim dependency traversal and explicit gap relationships.
- [x] Define source checks, cancellation, concurrency handling, and observation boundaries.
- [x] Report unsupported/unavailable checks rather than inventing clean results.
- [x] Keep audit free of model calls, uploads, and automatic command execution.
- [x] Decide which existing review events are persisted versus which audit findings are observational (audit is entirely observational).
- [x] Preserve the rule that review flags do not clear automatically.
- [x] Integrate the audit into the investigation skill's pre-answer step.
- [x] Allow provisional answers with disclosed limitations.
- [x] Validate runtime and registered tool structured output for direct/nested callers using existing harnesses; no new live codemode validation.
- [x] Update README and command/tool help.

### Optional later strict mode

Do not build strict mode initially. Reconsider only after usability evaluation.

If introduced, strictness should mean “do not label this investigation complete while declared structural requirements fail,” not “prevent communication until every uncertainty disappears.”

### Acceptance tests

- [ ] Missing, retracted, superseded, and review-required references are reported correctly.
- [ ] Source change and source unavailability are distinguished where possible.
- [ ] Unrelated gaps do not block or dominate the selected audit.
- [ ] Historical applicability is visible without semantic overclaiming.
- [ ] Cancellation and session replacement discard stale work.
- [ ] No provider call, upload, or render-triggered filesystem work occurs.
- [ ] A clean structural result does not claim semantic correctness.

---

## 11. Phase 5 — discoverability and UI

### Direction

Keep the sidebar a compact summary, not a dense graph viewer. Proposed summary concepts:

```text
EVIDENCE / local
  6 source observations
  18 tool receipts
  3 established claims
  2 hypotheses
  2 review items
  1 open gap
```

Actual presentation must remain width-aware and should not imply that counts measure investigation quality.

### Inspection affordances

- Claim and supporting evidence.
- Gap and the conclusion it concerns.
- Why a record needs review.
- Replacement/origin chain.
- Dependents affected by a changed source.
- Current working-set capacity and explicit recovery action.

Possible command surface:

```text
/midnight evidence status
/midnight evidence show <id>
/midnight evidence check
/midnight evidence audit ...
/midnight evidence rollover ...
```

`audit` and `rollover` are proposals, not existing commands at plan creation. Keep richer operations in the structured tool rather than adding a command for every internal action.

### Tasks

- [ ] Finalize summaries after underlying schemas stabilize.
- [ ] Keep receipt, maturity, review, gap, and capacity labels honest.
- [ ] Add bounded relationship inspection without rendering-time I/O.
- [ ] Preserve full original structured results when compact rows are expanded.
- [ ] Keep non-interactive operation usable without fullscreen panels.
- [ ] Add tests for clipping, Unicode, ANSI safety, and semantic status colors.
- [ ] Update README, help, and examples only for shipped behavior.

### Manual UI gates

Run with only the local package loaded, using repository guidance.

- [ ] Keyboard interaction.
- [ ] Mouse interaction.
- [ ] Narrow terminal widths and long IDs/text.
- [ ] Resize and panel visibility changes.
- [ ] Reload and shutdown cleanup.
- [ ] Conversation-tree navigation.
- [ ] Unicode and ANSI-safe output.
- [ ] Non-interactive modes remain unaffected.

Do not mark manual UI gates complete based solely on unit tests. If unavailable, record them as unverified release gates.

---

## 12. Phase 6 — verification and benefit evaluation

### 6A. Deterministic software tests

Build these alongside each phase, not only at the end.

- [ ] Capacity exhaustion and recovery.
- [ ] Rollover lineage and bounded historical inspection.
- [ ] Structured review reasons and multiple causes.
- [ ] Claim maturity transitions.
- [ ] Gap concern/resolution relationships and reopening.
- [ ] Selected-claim audits.
- [ ] Missing/superseded/retracted references.
- [ ] Source changes between operations and unavailable sources.
- [ ] Cancellation, reload, session replacement, and branch replay.
- [ ] Legacy and malformed persistence.
- [ ] Direct/nested calls, structured outputs, pagination, and bounds.
- [ ] Privacy and absence of implicit network/model calls.

### 6B. Scripted investigation scenarios

Create small fixtures with explicit expected outcomes.

| Scenario | Setup | Success criterion |
| --- | --- | --- |
| A: Corrected premise | Early evidence suggests safety; later evidence reveals an exception | Earlier conclusion is revised and not repeated as current truth |
| B: Irrelevant uncertainty | Distracting repository issues unrelated to the question | Workflow does not continue investigating unrelated gaps |
| C: Misleading successful command | Command exits zero but does not exercise relevant behavior | Receipt is not promoted into a correctness claim |
| D: Changed evidence | Source changes after a conclusion is recorded | Conclusion is flagged and reassessed before being presented as current |
| E: Incomplete validation | Access or authorization for a remaining check is unavailable | Workflow stops and clearly states the limitation |
| F: Revision pressure | Repeated corrections exhaust a working set | Supported recovery preserves provenance and allows further correction |

- [ ] Implement fixtures and expected outcomes for A–F.
- [ ] Separate deterministic tool behavior from behavior that requires a model to exercise.
- [ ] Ensure fixtures contain no real credentials or confidential data.
- [ ] Document what scripted success does and does not establish.

### 6C. Separately approved model evaluation

**Blocked until explicitly authorized.** Mocked/local tests are the default. Runtime helper opt-in is not approval for paid evaluation.

Compare, under fixed tasks and scoring:

1. Ordinary coding workflow.
2. Ledger available without investigation skill.
3. Ledger plus gap-driven skill.
4. Ledger plus skill and pre-answer audit.

#### Approval and experiment design

- [ ] Ask for explicit provider/model, data, budget, and live-evaluation approval.
- [ ] Specify tasks, scoring rubric, run counts, and stop conditions before execution.
- [ ] Separate task-quality effects from model/provider changes.
- [ ] Record actual request attempts, failures, elapsed time, usage, and known/unknown cost.
- [ ] Ask before retrying failed paid requests; no automatic retries to complete a benchmark.
- [ ] Report incomplete runs and uncertainty honestly.

#### Useful metrics

- Incorrect conclusions after contradictory evidence appears.
- Unsupported final claims.
- Important gaps omitted from the answer.
- Unnecessary investigation steps.
- Successful incorporation of corrections.
- Time to a sufficiently supported answer.
- Agent/user effort spent on bookkeeping.
- Authorized, measurable token usage and known versus unknown cost.

#### Not primary success metrics

- Number of records.
- Number of tool calls.
- Percentage of gaps marked resolved.
- A clean-looking sidebar.

These can all improve while answer quality gets worse.

### Phase 6 exit gate

- [ ] Deterministic scenarios establish software behavior.
- [ ] Any model-benefit claim is supported by an approved evaluation, not inferred from the paper.
- [ ] If model evaluation is not authorized, mark it deferred and report benefit as unmeasured; do not claim completion of that optional evaluation.
- [ ] Findings feed back into scope, workflow instructions, and defaults.

---

## 13. Delivery strategy and first milestone

### First useful milestone — selected scope

The user selected the recommended first milestone during Phase 0. Included: capacity recovery, structured review, minimum relationship semantics, opt-in skill, advisory audit, and supporting regression/compatibility/documentation work. The optional items below remain deferred, not removed from the full roadmap.

Must have:

- [ ] A safe explicit path to continue after capacity pressure.
- [ ] Structured review reasons.
- [ ] The minimum relationship semantics needed for a trustworthy selected-claim audit.
- [x] A focused opt-in evidence-investigation skill (Handoff 014; explicit-only, model benefit unmeasured).
- [x] A selected-claim pre-answer audit (Handoff 014; read-only and advisory).
- [ ] Regression tests, compatibility handling, and documentation for those behaviors.

Deferrable:

- [ ] Hypothesis/established UI and, if necessary, its schema extension.
- [ ] Dedicated test-evidence source types.
- [ ] Rich relationship browsing.
- [ ] Excerpt-aware freshness explanations.
- [ ] Strict investigation mode.
- [ ] Approved live model evaluation.

Record explicit deferrals with reasons; do not silently erase them from the roadmap. A milestone can ship with documented deferrals even though the full roadmap remains incomplete.

### Focused execution sequence after Handoff 010

This is the active implementation order. Historical handoffs remain evidence of earlier slices, not a reason to repeat them. The user requested focused, efficient implementation without unnecessary tests.

1. **Reconcile status, not rebuild infrastructure.** Capacity-recovery development controls are implemented and automatically tested. Keep manual fullscreen/reload compatibility explicitly release-blocking. Do not rerun completed suites or add infrastructure merely because that manual gate is open.
2. **Define the minimum Phase 1B/1C contract.** Inspect the current reducer, versioned persistence/results, carry-forward closure, and selected-claim audit requirements. Specify bounded structured review reasons and separate support, gap concern, and resolution support. Preserve existing origin/replacement lineage. Map ambiguous legacy prose to `legacy_unspecified`; do not invent missing relationships. Ask only about consequential unresolved compatibility/behavior decisions.
3. **Implement structured review reasons.** Update version-aware storage/results and only the presentation needed to explain reasons. Preserve conservative invalidation and review after source restore/reload. Do not change unrelated lifecycle behavior or add a dashboard.
4. **Implement minimum relationship semantics.** Preserve gap concerns through resolution/reopening; adjust dependency invalidation and carry closure only where required. Keep historical compatibility explicit. No rich browsing, speculative schema features, or unrelated refactoring.
5. **Validate and record the coherent slice.** Extend existing tests for changed legacy mapping, review reasons, concern preservation, invalidation, and rollover behavior. Reuse existing cancellation/runtime coverage unless the change affects it. Run relevant focused tests during development, then final check/full tests once; repeat only for failure or relevant subsequent code changes. Update specification, README/help where behavior changed, and handoff with actual results and remaining blockers.
6. **Implement the opt-in investigation skill.** Reuse the stable evidence operations to guide gap selection, observation, revision, and qualified stopping. No automatic prompt injection or competing context owner.
7. **Implement the advisory selected-claim audit.** Check the selected claims' structural support, unresolved concerns, and freshness/review limitations using the established semantics. Never present the audit as truth verification. Add only targeted regression coverage for its new contract.
8. **Close the milestone, not the full roadmap.** Review the selected must-haves and documentation against actual behavior. Stop implementation when their gates pass. Any unperformed manual/runtime gate remains an explicit release blocker: report “implementation ready, release blocked,” not “released/complete.” Optional work stays deferred; do not begin it without new scope.

Prefer small, coherent changes and reuse existing modules/public APIs. Do not introduce new abstractions, dependencies, harnesses or speculative performance work without a demonstrated requirement. Test count is not a completion metric. No paid/provider evaluation or manual UI work is authorized by this sequence.

### Per-slice validation discipline

- [ ] Extend existing tests first; add only cases tied to changed behavior, a reproduced defect, or a consequential compatibility/safety boundary. Avoid duplicate suites and unnecessary harnesses.
- [ ] Run relevant focused tests during development; reuse established passing coverage when the affected behavior has not changed.
- [ ] For documentation-only changes, inspect the diff and relevant references rather than running code tests.
- [ ] Run `npm run check` and `npm test` once for final code changes; repeat only after failures or subsequent relevant changes.
- [ ] Use local/mock fixtures for routine validation.
- [ ] For substantial noisy logs, save relevant UTF-8 output under `.artifacts/` and use local-first log triage under existing authorization rules; preserve actual command exit codes separately.
- [ ] Inspect small failures directly; prefer dedicated parsers for structured reports.
- [ ] Update README when behavior, commands, defaults, compatibility, or privacy changes.
- [ ] Report checks not run and manual/runtime release gates still open.
- [ ] Do not reinstall dependencies, run unrelated benchmarks, or change compatibility pins without need and approval.

## 14. Explicit non-goals for the initial work

- Automatic web research.
- Background model verification or summarization.
- Automatic semantic gap resolution.
- Automatic execution of proposed investigations.
- Cross-session global knowledge graphs.
- Mandatory ledger injection into every prompt.
- Replacing context management with paper-style full-history prompting.
- Enforcing one operation per turn globally.
- Replacing existing coding tools with the paper's document environment.
- A mandatory numerical compute interface for ordinary coding tasks.
- Claims of LongHarness-equivalent benchmark performance.
- Dependency upgrades, unrelated refactors, or external CLI integrations.

## 15. Decisions and unresolved design questions

### Recommended directions, not yet implemented

| ID | Direction | Reason |
| --- | --- | --- |
| D1 | Bounded working sets with explicit rollover | Preserve historical provenance without permanently blocking corrections or allowing unbounded live state |
| D2 | Structured review reasons before weakening invalidation | Improve reassessment while retaining conservative safety |
| D3 | Explicit support/concern/resolution/origin semantics | Avoid overloading one relationship with incompatible meanings |
| D4 | Opt-in skill before automatic prompt injection | Gain workflow discipline without new context ownership or mandatory overhead |
| D5 | Advisory selected-claim audit before hard final gating | Improve answer preparation without blocking useful provisional communication |
| D6 | Derive receipt distinctions from existing metadata where practical | Avoid redundant schema fields |
| D7 | Local/mock validation by default | Preserve privacy, cost boundaries, and reproducibility |

### Questions to settle during design

- [ ] What exact versioned representation best supports rollover and bounded historical lookup?
- [ ] How are selected dependency closures validated and committed atomically enough for Pi's append-only API?
- [ ] What identity/origin model preserves branch replay and unambiguous references?
- [ ] How are legacy gap relationships represented without inventing missing information?
- [ ] How many review causes are retained, and how are they summarized within bounds?
- [ ] What is the conservative maturity interpretation for legacy claims?
- [ ] Is an investigation scope a separate persisted concept or initially a selection of existing record IDs?
- [ ] Which audit findings persist as events, and which remain observational results?
- [ ] Does explicit test-report capture suffice before adding another source type?
- [ ] What user-facing interaction makes rollover understandable without excessive ceremony?

Ask the user before implementing unresolved choices that materially affect scope, compatibility, privacy, cost, or user-facing behavior. Do not ask about facts available from the repository or trivial implementation details.

### D8 — Phase 0 scope and first milestone (2026-10-14)

- **Decision:** deliver baseline specification and passing characterization scaffolding only in Phase 0; retain the selected first milestone from section 13.
- **Reason:** stabilize lifecycle and compatibility expectations before changing persistence. Avoid a large mixed refactor or tests that fail solely because v2 does not exist yet.
- **Deferred:** claim maturity labels/schema, rich UI, dedicated test evidence, excerpt-aware diagnostics, strict mode, and live evaluation. These are not required for the first usable capacity/workflow/audit milestone.
- **Compatibility/privacy/cost:** no production/schema/API/dependency changes in Phase 0; no provider calls or benchmarks.
- **Approval:** milestone selection obtained; exact rollover UX/representation/downgrade policy remains a proposal to review before implementation.
- **Files/tests:** `docs/evidence-phase-0.md`, `tests/evidence.test.ts`, `tests/fixtures/evidence-v1.json`.

### D9 — Proposed capacity implementation boundary (2026-10-14)

- **Proposal, not implementation approval:** explicit bounded working sets, stable record IDs qualified by set, exact dependency closure including inactive support, one versioned snapshot event, and bounded historical lookup.
- **Reason:** preserve provenance and review state without unbounded live records or pretending retraction frees space. Do not carry old observations as fresh captures.
- **Persistence qualification:** a single Pi custom entry is a logical boundary, not guaranteed durable atomicity. Append exceptions may occur after in-memory mutation; fail closed/reconcile rather than automatically retry.
- **Compatibility qualification:** v1 readers cannot be made fail-closed retroactively. Migrated branches must not be written with an old binary; new readers must detect incompatible history.
- **Next decision:** review section 5/6 of the Phase 0 specification before implementing Phase 1A. Proposed 256-record/2 MiB carry budgets and archive scan limits are not shipped defaults.

### D10 — Approved Phase 1A contract and internal-model slice (2026-10-14)

- **Approval obtained:** explicit user selection approved preview + commit, at most 256 carried records / 2 MiB, preserved dependencies/review, bounded historical inspection, and no old-version writing on migrated branches. This is not approval for provider checks or automatic migration.
- **Delivery boundary:** implement and validate the pure model first; runtime, persistence, tools, archive access and compatibility UI follow separately. Phase 1A remains incomplete until those gates pass.
- **Prototype representation:** distinct `midnight-evidence-v2` entry type; strict snapshot and scoped-update envelopes; stable IDs with set/anchor-qualified locators. Incremental operations deliberately wrap unchanged v1 reducer semantics, not a premature implementation of 1B/1C.
- **Canonical digest:** SHA-256 of UTF-8 JSON with lexical object-key sorting and preserved array order. Undefined optional properties follow JSON omission. The preview token covers the full generated event, including explicit selection and predecessor identity/digest. Snapshot bytes are measured from serialized UTF-8 event data.
- **Legacy compatibility:** deterministic legacy identity requires a caller-supplied stable ancestry identity. Preserve invalid-event count and exact review prose. Unsupported extra legacy fields or malformed projection relationships refuse migration rather than silently drop data; the original v1 reader remains unchanged.
- **Open integration requirements:** stable fork/clone ancestry mapping; bounded cold replay/archive validation; operation-ID uniqueness and branch authorization; serialization of passive events; cancellation/generation checks; uncertain-append recovery; old/future/mixed history read-only state; bounded result schemas and legacy renderer support.
- **No claims of persistence safety yet:** pure functions do no Pi API calls, filesystem reads/writes, provider requests or UI changes. A digest is an integrity/freshness check, not proof of source truth or authorization to access another branch.

### D11 — Public-session adapter boundary (2026-10-14)

- **Decision:** keep `src/evidence/session-store.ts` internal and unregistered while validating replay, commit, archive, and uncertain-append behavior against Pi 1.2.0 public session reads and the extension append callback.
- **Identity:** derive legacy identity from the earliest v1 evidence entry ID and timestamp, or from the root entry when no v1 entry exists; never use the replaceable session header. Forks and ordinary branch extraction preserve entry IDs/timestamps. If branch extraction removes a label used as an exact transition anchor and rechains its child, replay fails closed rather than remapping the evidence anchor.
- **Replay:** collect only the selected active ancestry, in resumable pages of at most 2,048 entry inspections, with an 8,192-entry ancestry cap. Validate every predecessor transition from root to target. Malformed/future v2, v1-after-v2, duplicate operation IDs, duplicate working-set IDs, missing ancestry, and stale branch movement produce a read-only result.
- **Archive:** authorize the requested anchor by walking the current branch first. Continue scans with process-local branch-bound cursors, return at most 20 records, and retain at most two projection cursors using LRU eviction. A sibling entry ID is not authority. Cached pages expire on branch movement.
- **Commit/recovery:** validate on a detached projection, recheck the exact leaf and cancellation immediately before one synchronous append, then verify the expected custom entry through public reads. Any thrown or unverifiable append locks writes without retry. Recovery requires an explicit fresh writable replay whose target anchor and branch leaf both equal the current leaf.
- **Qualification:** one custom entry is a coherent replay boundary, not an fsync or filesystem transaction. A thrown append may already be visible in Pi memory. The adapter does not yet serialize runtime/passive operations, own session generations, publish results, register tools, or make v2 writes reachable from the extension.
- **Tests:** `tests/evidence-session-store.test.ts` covers migration/scoped replay, bounded archive pages/LRU, sibling denial, persistent reopen, fork/clone identity, exact label-anchor failure, malformed/mixed/duplicate history, bounded replay, stale/aborted commit, and append recovery before/after mutation.

### D12 — Fresh-session-only semantics (user decision)

- The user selected **New sessions only for now** instead of an upgrade through preview/commit. Existing v1/v2 replay, digests and lifecycle behavior must remain unchanged. An existing-session upgrade path is deferred, not implicitly authorized.
- Phase 1B/1C begins with a separate version-3 semantic reducer. Live activation must be restricted to fresh sessions and persisted in versioned history so reload/branch replay cannot silently change semantics. Do not infer freshness merely from an empty evidence ledger in an existing conversation.
- The initial reducer stores at most eight structured review causes, retaining the original review text and a sticky overflow indicator. Gap `concerns` and `resolvedBy` are distinct; `refs` is their bounded dependency union, while claim refs remain evidence support. Resolving/reopening retains concerns and review. Legacy inspection returns `legacy_unspecified`, without guessing categories from prose.
- This decision does not authorize migration, manual UI validation, provider requests, or expansion of the milestone.

### Decision log template

```text
Decision ID / date:
Phase:
Question:
Decision:
Reason and alternatives rejected:
Compatibility/privacy/cost impact:
User approval needed or obtained:
Files/tests affected:
```

## 16. Session handoff log

Append concise entries here at meaningful stopping points. Keep the current status and next action at the top synchronized.

### Handoff 001 — plan creation

- Scope: capture the full improvement roadmap and resumable checklists; no feature implementation.
- Repository state before creation: `git status --short` was clean.
- File added: `EVIDENCE_BUILD_PLAN.md`.
- Baseline validation: the preceding review ran 13 evidence tests successfully and separately reproduced correction failure at capacity. Those tests were not rerun for this documentation-only addition.
- Decisions: recommendations and open questions are recorded above; detailed storage/schema choices remain unsettled.
- Provider activity: no paid/provider validation authorized or performed for this plan.
- Next action: begin Phase 0 with current source inspection and a bounded working-set design plus regression specification.

### Handoff 002 — Phase 0 specification and scaffolding (2026-10-14)

- Scope: baseline inventory, lifecycle table, version/rollover design, legacy fixture, and five new characterization tests. No `src/` changes.
- Pre-existing work: root `EVIDENCE_BUILD_PLAN.md` was already untracked; preserved and updated. No other initial changes were present.
- Changed files: this plan, new `docs/evidence-phase-0.md`, new `tests/fixtures/evidence-v1.json`, and `tests/evidence.test.ts`.
- Findings: total capacity includes inactive history; resolved gaps lose concern refs and retain review; current-only propagation stops at historical claims; the active-file limit counts records, not paths; passive synchronous observations can interleave with async operations; append is not a durable transaction.
- Focused validation: `node --experimental-strip-types --test tests/evidence.test.ts` — 18 passed, 0 failed, 0 skipped; exit 0. Prior baseline was 13 tests.
- Final validation: `npm run check` initially exited 1 for one test-formatting difference (TypeScript did not run); fixed that formatting only, then reran successfully (exit 0, Biome and TypeScript). `npm test` exited 0: 141 tests, 140 passed, 0 failed, 1 skipped. The skipped checkpoint symlink-replacement test reported symlink creation unavailable on this host; the evidence symlink tests passed. Full tests were not repeated after the formatting-only correction.
- Logs: ignored `.artifacts/evidence-phase-0/{focused,check,check-final,test}.log`. Full log triage was local (`auto`, reported test totals), 0 new provider requests, 23 ms total / 0 ms provider wait. Original totals and skip reason were inspected; process exit codes came from the commands, not triage.
- Final change hygiene: `git diff --check` passed; production files and dependencies unchanged.
- Not run: manual UI/provider/benchmark/packaging/install checks (no relevant changes or authorization). No commit requested or made.
- Remaining: all production improvements; capacity defect intentionally still present. Future migration/disk-failure/race tests remain unchecked, not implied by the passing in-memory fixture.
- Next action: review the Phase 1A proposal (explicit preview/commit, stable IDs qualified by working set, closure/byte limits, and old-writer compatibility) before implementing recovery. Phase 0 is complete; Phase 1 is not started. Do not automatically expand this slice.

### Handoff 003 — Phase 1A internal working-set model (2026-10-14)

- **Status:** internal-model slice complete; Phase 1A and Phase 1 remain in progress. No runtime migration, new tool commands or v2 writes are exposed. The live v1 capacity defect remains until integration.
- **Approval:** user explicitly approved the D10 contract, including the old-writer restriction. No provider/benchmark authorization was requested or inferred.
- **Pre-existing work preserved:** modified `tests/evidence.test.ts`; untracked root plan, Phase 0 spec and frozen v1 fixture. Those tests/fixture were not changed during this slice.
- **Changed this slice:** added `src/evidence/working-set.ts` and `tests/evidence-working-set.test.ts`; updated this plan and appended section 10 in `docs/evidence-phase-0.md`. Existing production modules and dependencies unchanged.
- **Implemented:** strict internal v2 envelopes, detached legacy projection, canonical digest, exact bounded closure, preserved inactive support and lineage, preview token and anchor validation, unchanged v1 lifecycle in isolated scoped updates, and file/receipt limits. All work is pure/local; no source recapture or runtime integration.
- **Focused development validation:** both evidence suites passed, 29 tests / 29 pass / 0 fail / 0 skip, exit 0. After adding scoped predecessor-anchor binding, the full suite also passed.
- **Full validation:** `npm test` exit 0; 152 total / 151 pass / 0 fail / 1 skip. Checkpoint symlink-replacement test skipped because symlink creation was unavailable on this host; evidence symlink tests passed.
- **Check correction:** initial `npm run check` exited 1 on two test-only non-null-assertion warnings (TypeScript did not run). Replaced assertions with explicit `assert.ok` guards and formatted only the new files. `npm run check` then exited 0 (Biome and TypeScript). Reran the changed working-set suite: 11 / 11 pass, exit 0. The full suite was not repeated after those test-only guard changes; production code was unchanged.
- **Logs:** ignored `.artifacts/evidence-phase-1a/{focused,check,check-final,test,focused-final}.log` and targeted formatting logs. Full log triage used `auto` and returned local reported totals: 0 provider requests, 19 ms total / 0 ms provider wait. Original totals and skip line inspected; exit codes captured from commands, not inferred from triage.
- **Hygiene:** `git diff --check` passed. No dependency/install, manual UI, provider, benchmark or packaging checks; no commit made.
- **Known integration gaps:** stable fork/clone identity, ancestry authorization, bounded cold replay and archive validation, operation-ID uniqueness, passive ordering, cancellation/generation guards, malformed/future/mixed-history read-only state, uncertain append/disk recovery, bounded tool results, saved-result rendering, README/release downgrade warnings. Strict v2 migration refuses unsupported extra legacy fields rather than silently losing them.
- **Next concrete action:** read `docs/evidence-phase-0.md` sections 5–6 and 10 plus the new model/tests. Design the runtime replay/commit adapter around public Pi 1.2.0 APIs; add branch, mixed-history and append-failure tests before exposing preview/commit. Keep 1B/1C and broader workflow/UI changes outside that slice. Do not treat pure JSON round-trip tests as disk or archive validation.

### Handoff 004 — Phase 1A public-session adapter (2026-10-14)

- **Status:** replay/commit/archive infrastructure and its final validation are complete; Phase 1A and Phase 1 remain in progress. The adapter is not imported by `src/evidence/index.ts`, no v2 operation is registered, and existing v1 runtime behavior is unchanged.
- **Scope:** public Pi 1.2.0 session replay and ancestry identity, bounded archive access, detached commit validation, exact append verification, and fail-closed uncertain-append recovery. No runtime commands, 1B/1C semantics, UI, provider, packaging, or live checks.
- **Pre-existing work preserved:** modified `tests/evidence.test.ts` and the untracked plan, Phase 0 specification, v1 fixture, working-set model, and working-set tests. No reset, cleanup, dependency change, or commit was made.
- **Changed this slice:** added `src/evidence/session-store.ts` and `tests/evidence-session-store.test.ts`; exported `eventDigest` from `src/evidence/working-set.ts`; updated this plan and added section 11 to `docs/evidence-phase-0.md`.
- **Implemented:** resumable active-ancestry replay (2,048 inspections/page, 8,192 entries maximum); stable entry-derived legacy identity; strict predecessor and mixed-writer validation; branch-authorized archive pages of at most 20 records with two LRU cursors; one synchronous append with public-read verification; and explicit recovery after any thrown or unverifiable append, without retry.
- **Focused validation:** `node --experimental-strip-types --test tests/evidence.test.ts tests/evidence-working-set.test.ts tests/evidence-session-store.test.ts` — 39 tests, 39 passed, 0 failed, 0 skipped; exit 0. Targeted Biome and TypeScript checks also passed before final validation.
- **Final validation:** `npm run check` — exit 0; Biome checked 82 files with no warnings or fixes, then TypeScript passed. `npm test` — exit 0; 162 tests, 161 passed, 0 failed, 1 skipped, 0 cancelled/todo. The checkpoint symlink-replacement test was skipped because symlink creation was unavailable on this host; evidence symlink tests passed.
- **Logs and triage:** ignored `.artifacts/evidence-phase-1a-adapter/{check,test}.log`. Full-test triage ran locally in `auto` mode, scanned all 174 lines, reported the same totals, made 0 provider requests, and took 44 ms total / 0 ms provider wait. Command exit codes were captured independently rather than inferred from triage.
- **Final hygiene:** `git diff --check` passed, with only Git's informational LF-to-CRLF warning for the pre-existing modified `tests/evidence.test.ts`. Final `git status --short` still lists only the preserved Phase 0/1A evidence files and changes described above.
- **Remaining release gates:** serialize explicit and passive writes under one runtime queue; bind work to session generations and cancellation; define bounded public preview/commit/recovery/archive results; preserve saved v1 rendering; add runtime ordering/replacement tests; and document downgrade restrictions before any v2 write becomes reachable. Manual UI/runtime, provider, benchmark, packaging, and install checks were not run.
- **Next concrete action:** design the queued runtime integration and bounded v2 result contracts around the validated adapter. Keep the feature internal until cancellation, session-generation, passive-ordering, renderer, and downgrade-documentation gates pass; keep 1B/1C and broader UI/workflow work outside that slice.

### Handoff 005 — Phase 1A internal queued runtime and result contracts (2026-10-14)

- **Status/scope:** internal runtime-contract slice validated; Phase 1A and Phase 1 remain in progress. Added no live registration, commands, UI, providers, or 1B/1C semantics. The live v1 capacity defect is still present.
- **Pre-existing work preserved:** modified `tests/evidence.test.ts`; untracked plan, Phase 0 spec, frozen v1 fixture, working-set model/tests and session-store adapter/tests. No dependency changes, reset, cleanup, or commit.
- **Changed this slice:** added `src/evidence/runtime-v2.ts`, `src/evidence/result-v2.ts`, and `tests/evidence-runtime-v2.test.ts`; updated this plan and appended section 12 in `docs/evidence-phase-0.md`. The harness imports the existing read-only receipt extraction helper but is not imported by the live extension.
- **Implemented internally:** one FIFO queue for reads, explicit writes, and v2 passive review/receipt writes; session/generation guards; cancellation before append; committed results for cancellation after successful append; stale-generation publication suppression; same-manager/session uncertain-append lock retention across stop/start and explicit fresh-replay recovery. No retry or rollback.
- **Result contracts:** closed, action-discriminated schemas for list/preview/commit/update/recover/archive; at most 20 records per page (default 10); paginated omitted/review IDs; bounded preview metadata rather than the full snapshot event. Cached previews retain the same token across pages for unchanged selection/anchor/digest. Builder types have optional variant fields; every returned result is schema-checked.
- **Bounds qualification:** unchanged leaves reuse one live projection; one preview and at most two archive projection cursors are retained. Cold/moved-leaf live replay yields between 2,048-step pages with an 8,192-entry ancestry cap, but does not yet replay incrementally. Archive first synchronizes the live projection, then performs its bounded archive-reader step. `archive.inspected` counts only that reader step, not preceding synchronization. Therefore the total archive-call inspection budget is **not yet satisfied** on a cold/moved leaf; this is a release gate, not a bounded-total-work claim.
- **Minimal focused tests:** six runtime scenarios passed (exit 0), covering bounded capacity/archived history and pagination, passive ordering/stale previews, cancellation before/during queued work, generation replacement, post-append cancellation/uncertain recovery, and branch movement/mixed-history read-only behavior.
- **Final validation:** initial `npm run check` exited 1 after Biome passed because a test's `Value.Check` assertion narrowed a preview to the result union without narrowing its action. Added only the explicit action assertion. Final `npm run check` exited 0 (85 files, Biome and TypeScript). `npm test` ran once for final code changes and exited 0: 168 total, 167 passed, 0 failed, 1 skipped, 0 cancelled/todo. Checkpoint symlink-replacement test skipped because symlink creation was unavailable on this host.
- **Logs/triage:** ignored `.artifacts/evidence-runtime-v2/` logs; final `check.log` and `test.log` hold successful validation. Test triage used `auto`, returned local reported totals, scanned all 180 lines, made 0 provider requests, and took 38 ms total / 0 ms provider wait. Original totals and skip reason were inspected; command exit codes were captured independently.
- **Hygiene/checks not run:** `git diff --check` passed (only the inherited test's informational LF-to-CRLF warning). No manual UI/live/provider/benchmark/install/packaging checks; dependencies and existing production modules unchanged.
- **Remaining gates/next action:** bound total archive-call work and add incremental live replay; integrate v1 passive writes and source capture/check/navigation review under the shared queue; connect lifecycle/tool/command paths only after saved-v1/v2 rendering and README/release downgrade restrictions are ready. Complete relevant runtime/manual compatibility checks before exposure. Do not expand into 1B/1C or broader workflow/UI work.

### Handoff 006 — Phase 1A incremental replay and archive-call budgets

- **Scope/acceptance:** close the two scan gates from Handoff 005 internally: unchanged leaves inspect no entries, validated descendant replay inspects only the delta, navigation falls back safely, and every archive call charges all public entry reads to one 2,048-inspection page. Preserve the 8,192-entry ancestry cap, branch authorization, cancellation, uncertain-append recovery, and strict bounded results. No live registration or Phase 1B/1C changes.
- **Pre-existing work:** all inherited Phase 0/1A files and modified `tests/evidence.test.ts` preserved. No dependencies, existing live production modules, or installed packages changed; no reset, cleanup, or commit.
- **Changed:** `src/evidence/session-store.ts`, `src/evidence/runtime-v2.ts`, `src/evidence/result-v2.ts`, two related test files, this plan, and `docs/evidence-phase-0.md`.
- **Implementation:** trusted generation-local projection reuse requires walking to the exact prior leaf. A sibling/ancestor/new root falls back to cold replay; explicit recovery always replays fresh. Seeded ancestry counts retain the full cap. Root/failure paths no longer make uncharged entry reads, authorization and collection share the archive ancestry cap, and append preflight refuses crossing the cold-replay cap.
- **Archive contract:** no preceding live synchronization. Every call performs at most one bounded reader step; final success and locator-mismatch results include the finishing step's inspections. Archive results omit live summary/mode/writable metadata and report `total: null` while unavailable rather than implying zero records. Continued scans/pages stay branch-bound and two-cursor LRU-limited. This is an internal unregistered schema adjustment, not a saved-result migration.
- **Validation:** focused `node --experimental-strip-types --test tests/evidence-runtime-v2.test.ts tests/evidence-session-store.test.ts` passed 18/18 (exit 0) before the final cap safeguards. Added only two runtime scenarios and extended existing adapter cases. Targeted Biome formatting fixed two changed files. Final `npm run check` passed (exit 0, 85 files, then TypeScript); final `npm test` ran once for final code and passed (exit 0): 170 total, 169 passed, 0 failed, 1 skipped, 0 cancelled/todo. The checkpoint symlink-replacement case skipped because host symlink creation was unavailable; evidence symlink cases passed.
- **Logs/triage/hygiene:** ignored `.artifacts/evidence-scan-v2/{check,test}.log`. Full-test triage used `auto`, ran locally over all 182 lines, made 0 provider requests, and took 19 ms total / 0 ms provider wait. Original totals, added cases and skip reason inspected; command exit codes captured separately. `git diff --check` passed (exit 0), with only the inherited test's informational LF-to-CRLF warning. No code changes after final validation.
- **Remaining gates/next action:** integrate legacy/passive writes and source capture/check/navigation review in the shared queue; preserve saved-v1/v2 rendering and document downgrade restrictions before tool/command registration. Relevant manual/runtime compatibility remains a release gate. Phase 1A is not complete; live v1 capacity recovery is not fixed. No UI/live/provider/benchmark/install/packaging checks requested or run.

### Handoff 007 — Phase 1A internal legacy/passive and source-I/O queue integration

- **Scope/acceptance:** advance the next gate from Handoff 006 inside the unregistered runtime. Serialize v1/v2 writes, passive observations, capture/check I/O, and navigation review; preserve current record semantics and source privacy/bounds. No live registration or Phase 1B/1C changes.
- **Pre-existing work:** inherited modified `tests/evidence.test.ts` and all untracked Phase 0/1A files preserved. No dependencies, installed packages, existing live production modules, reset/cleanup, or commit.
- **Changed:** `src/evidence/session-store.ts`, `src/evidence/runtime-v2.ts`, `src/evidence/result-v2.ts`, `tests/evidence-runtime-v2.test.ts`, this plan, and `docs/evidence-phase-0.md`.
- **Implementation:** legacy commits validate a detached reducer/projection and use the same verified append/uncertain-lock boundary as v2. They retain the original v1 event envelope until explicit migration; the first legacy evidence entry supplies stable identity. Internal `execute` handles existing request parameters with bounded filtered/ID results. Capture/check I/O is injectable for tests and defaults to unchanged project-contained bounded readers; guards after awaited I/O reject cancellation, generation replacement, or moved branch leaves before appending/publishing.
- **Check/navigation:** checks read each unreviewed path once and gather reads before review appends; unavailable reads never mean clean, matching/restored hashes never clear review, and cancellation after a successful review returns the committed prefix with `cancelledAfterAppend`. Starting/restarting schedules conservative current-claim review without immediate I/O/appends; queued synchronization performs/publishes it. Lifecycle wiring must call `start` on navigation, including returning to a previously seen descendant: parent pointers alone cannot distinguish that from new append-only descendants. Cold non-ancestor replay also schedules review. Post-append generation guards prevent stale results/projections from leaking into a replacement manager.
- **Tests:** only three grouped runtime scenarios added; existing uncertain-append scenario extended for legacy before/after mutation and append-time replacement. Coverage includes FIFO captures/receipts, migration without recapture, Unicode source preservation, filtered/ID lookup, path-deduplicated checks, missing/restored files, source-I/O races, committed prefixes, and queued navigation. First focused run exited 1 (21 total, 20 passed): fixture omitted the navigation lifecycle hook on ancestor-to-seen-descendant navigation. Fixed the fixture to model the required hook, not to weaken review semantics. Final focused run passed 21/21 (exit 0). Targeted Biome formatting fixed three changed files.
- **Final validation:** `npm run check` exited 0 (Biome checked 85 files with no fixes; TypeScript passed). `npm test` ran once for the final code and exited 0: 173 total, 172 passed, 0 failed, 1 skipped, 0 cancelled/todo. The checkpoint symlink-replacement test skipped because this host cannot create symlinks. Logs: ignored `.artifacts/evidence-queue-io-v2/{check,test}.log`. Auto test-log triage ran locally across all 185 lines, made 0 provider requests, and took 19 ms total / 0 ms provider wait; original totals, new scenarios and skip reason inspected, command exits captured separately. `git diff --check` exited 0 with only the inherited test's informational LF-to-CRLF warning. No code changed after final validation.
- **Remaining gates/next action:** saved-v1/v2 rendering and downgrade/old-writer README/release documentation, then lifecycle/tool/command registration and relevant runtime/manual compatibility checks. Public caller cancellation and partial-write presentation must remain honest when connecting the internal result contract. Phase 1A remains incomplete; shipped v1 capacity recovery is unchanged. No live/UI/provider/benchmark/install/packaging checks requested or run.

### Handoff 008 — saved-result rendering and downgrade guidance

- **Scope:** saved-v1/v2 compact rendering and README/unreleased old-writer guidance only. No v2 runtime registration, public rollover command, schema migration, or Phase 1B/1C changes.
- **Preserved:** inherited modified `tests/evidence.test.ts` and all untracked Phase 0/1A model/runtime/tests/spec/fixture files. No dependency changes, reset, cleanup, install, or commit.
- **Changed:** added pure `src/evidence/format-result.ts`, connected it to normal/error compact outcomes in `src/compact-tools.ts`, added frozen synthetic `tests/fixtures/evidence-results.json` and two grouped renderer regressions in `tests/compact-tools.test.ts`; updated README, added `docs/releases/unreleased.md`, and updated this plan/spec.
- **Presentation:** saved v1 summary compatibility retained. Strict v2 results distinguish preview-only, committed/cancelled-after-append, committed check prefixes, append uncertainty/write locks, read-only/issue/capacity state, and historical scanning/unavailable archive state with unknown totals. Unknown/malformed versions fall back. Rendering performs no source/replay/archive I/O and does not mutate raw/model-facing results; expansion/disabled views retain originals. Tests cover Unicode/narrow widths and error rows. No new runtime or tool registration.
- **Compatibility:** README/release notes explicitly prohibit any v1 writer (including the currently registered development runtime) on migrated branches; passive writes count. Old binaries ignore v2 entries. No released safe v2 writer is claimed, nor automatic merge/downgrade/repair/retry. Experimental migrated sessions must remain isolated; preserve originals and inspect raw saved results without loading an old writer.
- **Validation:** read Pi 1.2.0 extensions/tui docs and hello example. First focused renderer run: exit 1, 11 total/10 pass; preview fixture used an invalid predecessor set ID. Corrected the fixture to a valid legacy ID, preserving strict validation. Final focused `node --experimental-strip-types --test tests/compact-tools.test.ts`: exit 0, 11/11 passed. Targeted Biome formatting touched only new/changed renderer files/fixture. Final `npm run check`: exit 0 (87 files; TypeScript passed). Final `npm test`: exit 0, 175 total, 174 passed, 0 failed, 1 skipped, 0 cancelled/todo; checkpoint symlink-replacement case skipped because host symlink creation was unavailable.
- **Logs/triage:** ignored `.artifacts/evidence-render-v2/{check,test}.log`. Auto triage ran locally across all 187 test-log lines, 0 new provider requests, 41 ms total / 0 ms provider wait. Original totals/new cases/skip reason inspected; actual command exits separately captured. `git diff --check` exited 0 (informational LF-to-CRLF warnings only). Documentation/handoff updates follow validation; no subsequent code changes.
- **Next:** integrate lifecycle/tool/command paths with the shared runtime, including `start` on navigation and honest cancellation/partial-append results. Keep rollover unexposed until runtime/manual compatibility gates pass. Phase 1A remains incomplete; live v1 capacity defect remains. No provider/live/manual UI/benchmark/install/packaging validation run.

### Handoff 009 — live lifecycle/tool/command bridge

- **Scope:** user approved continuing with the live bridge after Handoff 008. Register the shared queue for existing actions/commands only; no public rollover, archive, recovery, provider calls, manual UI validation or Phase 1B/1C work.
- **Preserved:** all inherited Handoff 008 and Phase 0/1A changes, including modified `tests/evidence.test.ts` and untracked modules/spec/tests/fixtures. No dependency/install changes, reset/cleanup or commit.
- **Changed:** new `src/evidence/register.ts` and `tests/evidence-registration.test.ts`; `src/index.ts` imports the new bridge; `src/evidence/model.ts`, `src/sidebar.ts` and `tests/panels.test.ts` add presentation-only unavailable state. `runtime-v2.ts` corrects the capacity message and interrupted navigation review reporting. README, unreleased notes and plan/spec updated. Old `src/evidence/index.ts` remains for characterization/shared request and receipt definitions, no longer live registration.
- **Integration:** lifecycle startup/tree navigation starts and refreshes the queued runtime; shutdown aborts it. Passive observations, explicit source checks and existing tool/actions/commands share the FIFO. Bridge generation/session checks reject stale tool results/publication/notifications; runtime guards remain authoritative around I/O/appends. New outputSchema/structuredContent/details use v2 wrapped records. Legacy branches retain v1 storage events; no migration is triggered. Commands retain status/check/show and source/claim/review/gap counts.
- **Honesty:** read-only history and unavailable/loading/partial-check display states never become zero-clean sidebar counts. Verified post-append cancellation remains committed. Navigation cancellation publishes committed metadata then reports an interrupted prefix, retaining pending review for the next operation. An uncertain append remains locked across navigation; no automatic retry or publicly callable recovery was added. Capacity messages no longer recommend an unavailable rollover action.
- **Tests:** six grouped registration cases cover public schema/legacy storage, FIFO receipts/navigation/check hooks, post-append cancellation and persistent locks, real bounded source capture/check/restore, malformed-history refusal, interrupted navigation review and session replacement. Existing sidebar test extended for unavailable state. First registration run 3/4 passed (exit 1): JSON comparison incorrectly expected undefined optional fields to survive serialization; fixed test comparison and two lint warnings. Then 4/4 passed. Final focused runtime/registration/panels run: 26/26 passed, exit 0.
- **Final validation:** first `npm run check` exited 1 on a test-only context type (`ExtensionContext` versus `ExtensionToolContext`); corrected only the erased type import/assertion. Rerun `npm run check` exited 0 (89 files plus TypeScript). `npm test` exited 0: 181 total, 180 passed, 0 failed, 1 skipped, 0 cancelled/todo; checkpoint symlink-replacement case skipped because host symlink creation was unavailable. The full run preceded only that erased test-type correction, so it was not redundantly rerun. No runtime changes followed validation.
- **Logs/triage/hygiene:** ignored `.artifacts/evidence-live-v2/{check,check-final,test}.log`. Auto test triage ran locally across all 193 lines, made 0 new provider requests, 34 ms total / 0 ms provider wait. Original totals and host skip inspected; actual process exits captured separately. `git diff --check` exited 0 with informational LF-to-CRLF warnings only. No manual UI/live/provider/benchmark/install/packaging validation run.
- **Next:** assess remaining public preview/commit and bounded archive/recovery controls plus relevant manual/runtime gates before exposing rollover. Phase 1A is incomplete and ordinary capacity recovery is still unavailable. No new released version or broad compatibility claim is made.

### Handoff 010 — user-confirmed public capacity recovery

- **Scope/decision:** user requested the immediate capacity-recovery step and explicitly selected **User-confirmed commit** through `midnight_question`. Model-callable preview/archive are allowed; commit and lock recovery require idle TUI command confirmation. No automatic migration, provider calls, or manual UI validation authorized.
- **Changed:** new `src/evidence/public-params.ts`; extended `register.ts`, capacity guidance in `runtime-v2.ts`, and dialog ownership in `src/index.ts`. Extended registration tests with two grouped scenarios. README/unreleased notes and plan/spec updated. All inherited changes preserved; no reset, install, dependencies or Git commit.
- **Public contract:** tool `preview` requires explicit `selected` IDs (empty array intentionally carries nothing), with bounded pages. `archive` accepts the preview predecessor locator or continuation cursor. Commands support `preview <ids...>`, `preview --empty`, `commit <token>`, and `recover`. No model commit/recover action. Carry limit remains 256 records / 2 MiB, preserving semantic dependencies and review flags. Archive lookup retains bounded scans/pages and does not establish live freshness.
- **Confirmation:** displays carried/omitted/review counts, bytes/free slots, warnings and prohibition on older/v1 writers. Busy/noninteractive/concurrent/declined/stale-token/replaced-session/changed-branch attempts cannot authorize commit. Recovery confirms a fresh replay, never retry/rollback/repair. Evidence confirmation shares overlay ownership with questions/triage/panels and closes previews before opening.
- **Validation:** focused registration tests passed 8/8, then registration/panels passed 17/17 after dialog integration. Final `npm run check` exited 0 (90 files, TypeScript passed). Full `npm test` exited 0: 183 total, 182 passed, 0 failed, 1 skipped, 0 cancelled/todo. Checkpoint symlink replacement skipped because host symlink creation was unavailable. New coverage includes full-512 recovery, post-rollover correction, historical pagination, declined/busy/noninteractive confirmation, stale/replaced confirmation and explicit uncertain recovery without retry.
- **Logs/triage:** ignored `.artifacts/evidence-public-v2/{check,test}.log`. Auto triage was local over all 195 test lines; 0 new requests, 47 ms total / 0 ms provider wait. Original totals and skip inspected; process exit independently captured. `git diff --check` passed with informational LF-to-CRLF warnings only. No runtime code changes after final validation; only handoff/spec updates.
- **Release boundary/next:** development controls are implemented, not a release certification. Manual fullscreen/reload/lifecycle compatibility remains an explicit blocker; no manual/live/provider/benchmark validation performed. Close or explicitly retain those gates, then move to structured review/minimum relationship semantics rather than extending infrastructure indefinitely. First milestone still also requires opt-in skill and advisory selected-claim audit.

### Handoff 011 — focused execution guidance (documentation only)

- **Request:** update repository agent guidance and this plan to keep the remaining milestone focused and efficient, without unnecessary tests.
- **Changed:** `AGENTS.md` now requires smallest-coherent-change implementation, existing-test reuse, no speculative infrastructure/optimization, and explicit implementation-versus-release stopping criteria. Section 13 replaces the broad suggested sequence with concrete Phase 1B/1C → opt-in skill → advisory audit steps; the top-level next action matches it.
- **Scope preserved:** Handoff 010 capacity controls stay implemented; manual fullscreen/reload compatibility remains release-blocking, not silently satisfied. No provider/manual validation authorized. Optional maturity UI, rich browsing, dedicated test evidence, strict mode, and live evaluation remain deferred.
- **Validation:** documentation diff inspected; no implementation changes or code test runs needed. Existing Handoff 010 results are historical, not rerun validation. All inherited work preserved; no dependency changes, reset or commit.
- **Next:** inspect and define the minimum structured-review/relationship contract, then implement only that coherent slice with targeted regression updates.

### Handoff 012 — Phase 1B/1C semantic reducer (not yet live)

- **Request/decision:** build the next phase with minimal tests. Source inspection found that changing old replay semantics would change snapshot digests. The user explicitly chose **new sessions only for now**, deferring upgrade of existing sessions.
- **Implemented:** `src/evidence/semantics.ts` defines strict v3 events/records and a detached-state reducer reusing existing add/resolve validation. Structured review codes retain up to eight distinct causes plus a sticky overflow flag; duplicate causes do not consume slots. Review never clears implicitly. Current versus historical invalidation remains conservative. Separate gap concerns/resolution support survive resolution/reopening, with refs as the bounded dependency union. Rejected transitions do not mutate state; self/cycle guards and dependency propagation are bounded. Legacy review inspection labels prose `legacy_unspecified` rather than inferring a category.
- **Boundary:** the new reducer is not imported by the live runtime. Existing v1/v2 schemas, reducers, events, hashes and behavior remain unchanged. Phase 1B/1C is **in progress**, not shipped or complete. Fresh-session-only persistence, replay/result schemas, tool parameters, carry-forward and runtime reason emission still need integration; no legacy upgrade is permitted.
- **Tests:** extended existing `tests/evidence.test.ts` with only two grouped cases (no new harness/suite), covering reason bounds/stickiness, legacy rejection/inspection, historical/current invalidation, separate concerns/resolution support, supersession/reopening, deterministic reducer replay and rejection nonmutation. All inherited test edits preserved.
- **Validation:** focused evidence suite passed 20/20, exit 0. Final `npm run check` exited 0 (91 files plus TypeScript). Final `npm test` exited 0: 185 total, 184 passed, 0 failed, 1 skipped, 0 cancelled/todo; checkpoint symlink creation unavailable on host. Auto triage local over 197 lines, 0 provider attempts, 37 ms total / 0 provider wait. Original totals/skip inspected. Logs `.artifacts/evidence-semantics/{check,test}.log`; `git diff --check` passed with informational LF-to-CRLF warnings. No code changes after validation.
- **Next:** wire the v3 contract into fresh-session-only storage/runtime/results and existing carry-forward behavior without modifying saved legacy hashes. Preserve explicit commit ownership and bounded history. Add only targeted integration regressions; do not duplicate established cancellation tests. No manual UI/provider validation, install, dependency changes, reset or commit performed.

### Handoff 013 — live v3 structured review and relationship integration

- **Scope:** connect the reducer to live runtime and complete this integration, not skill/audit expansion. Preserve D12 new-sessions-only semantics and all inherited changes. No legacy upgrade, dependency change, reset, install or commit.
- **Implemented:** v3 initialize/update/rollover schemas and semantic working-set validation in `working-set.ts`; replay/persistence and archive semantics in `session-store.ts`; fresh-session initialization, reason emission/deduplication, source checks and relationship input handling in `runtime-v2.ts`; live registration/command display, public parameter and result schema integration. Legacy envelopes and digest construction remain unchanged. Both concern and resolution dependencies survive closure, origin/replacement links, rollover and archive.
- **Freshness contract:** only Pi `session_start` reason `new` without preexisting conversation entries enables initialization. Use `/new`; startup/reload/resume/fork or an empty ledger do not authorize upgrade. Persisted v3 history remains v3 on reopen/fork. Failed initialization is not retried or downgraded within the runtime; missing initialization requires a new session, while confirmed recovery may validate an already-visible initialization. Mixed writers/version changes are refused.
- **Public behavior:** explicit concerns/resolvedBy require v3; refs remain aliases for gap-add/resolve inputs and cannot be combined with explicit fields. V3 records/results expose structured reasons, sticky overflow, and separate relationships. Command show displays them. Checks distinguish source_changed/source_unavailable, never clear restored-source review, and avoid duplicate cause writes. Worktree/dependency/reload/navigation causes remain explicit. User-confirmed commit/recovery and all existing bounds remain intact.
- **Tests:** only two grouped integration cases added to the existing registration suite/harness. Covers live capture/check/restore, relationships, rollover closure, archive, disk reopen/fork, unchanged legacy startup modes, mixed-writer refusal, and initialization failures before/after visibility with no retry or legacy fallback. Existing reducer/working-set/runtime/adapter suites reused.
- **Validation:** final focused four-suite run passed 42/42, exit 0. Final `npm run check` exited 0 (91 files plus TypeScript); full `npm test` exited 0: 187 total, 186 passed, 0 failed, 1 host symlink skip, 0 cancelled/todo. Auto triage ran locally across 199 lines, 0 provider attempts, 78 ms total / 0 provider wait. Original totals and skip inspected. Logs `.artifacts/evidence-semantics/integration-{focused-final,check,test}.log`. `git diff --check` passed (informational LF-to-CRLF warnings only). No runtime code changes after final validation; remaining edits documentation/handoff only.
- **Status/next:** Phase 1B/1C development integration complete for the approved new-session scope. README/unreleased/AGENTS/spec updated. Manual fullscreen/reload compatibility remains unverified and release-blocking; mocked/disk tests are not UI certification. No manual UI/live/provider checks performed. Remaining milestone deliverables are the opt-in skill and advisory audit, not more capacity infrastructure.

### Handoff 014 — opt-in workflow and read-only advisory audit

- **Scope completed:** user approved building the skill and selected-claim audit to completion, with focus and no unnecessary tests. Added `skills/midnight-evidence/SKILL.md`, explicit-only via `disable-model-invocation: true`, using existing package `./skills` discovery. Read Pi skills/packages docs and skill-creator guidance. No new dependencies, model evals, provider calls or prompt injection.
- **Audit contract:** `audit` requires 1–20 unique selected claim IDs; findings default/max 20 per page. Pure `planAudit` checks selected claims/support, reverse-linked concerns and resolution support, lifecycle/review, applicability, receipts and legacy limitations. Runtime cold replay uses the existing FIFO but bypasses sync/navigation review/initialization, so it performs no writes or sidebar publication. At most 32 distinct bounded file-read attempts; branch/session/cancellation guards discard stale work. Unavailable/locked history, unchecked sources, invalid events and pending navigation review stay explicit. Every call is a new observation, not a frozen multi-page transaction. No semantic correctness, unrecorded-gap coverage or external-state guarantee.
- **Wiring:** new `src/evidence/audit.ts`; public params/results union, runtime method, registered tool dispatch and compact formatter integrated. Existing actions and saved-result formats preserved. The skill guides material gaps, source admission, revision, audit, and qualified stopping; no hard response gate or automatic continuation. Receipt counts are explicitly not substantive-support coverage.
- **Targeted validation only:** two grouped tests added to existing runtime suite; existing live registration test extended for clean/non-clean audit, structured tool output, formatting and nonmutation. Tests cover read cap/pagination, missing/inactive/reviewed support, linked versus unrelated concerns, receipts, legacy limits, unavailable history and cancellation/branch/replacement races. Pi skill-loader local check confirmed one skill, zero diagnostics, explicit-only flag and no automatic prompt advertisement. No new harness or paid/model workflow evaluation.
- **Results:** focused runtime/registration run exited 0. Full `npm test` exited 0: 189 total, 188 passed, 0 failed, 1 skipped, 0 cancelled/todo; checkpoint symlink test skipped because host symlink creation was unavailable. First final check exited 1 on a test-only nullable leaf type; fixed only an erased type assertion/comment, then `npm run check` exited 0 (92 files plus TypeScript). Full tests preceded only that erased correction, so no redundant rerun. No production code changed afterward; final edits were skill wording/docs.
- **Logs/triage:** `.artifacts/evidence-audit/{check,check-final,test}.log`; auto triage local across all 201 lines, 0 new provider attempts, 36 ms total / 0 ms provider wait. Original totals and skip inspected; process exits captured independently. `git diff --check` passed with informational LF-to-CRLF warnings. All inherited changes preserved; no install/reset/dependency change/commit.
- **Stop boundary:** requested skill/audit implementation complete. No further infrastructure or optional roadmap features required for this development slice. Manual fullscreen/reload validation remains release-blocking; scripted model-use benefit has not been evaluated and no quality/cost claim is made. Model behavior cannot be proven by loader or deterministic tests. Optional maturity UI, richer evidence types, browsing, strict mode, excerpt freshness and live evaluations remain deferred. README/release notes/AGENTS/spec describe this boundary.

### Maintenance handoff — checkpoint loading latency (separate approved task)

- **Scope:** following read-only diagnosis, user approved fixing loading inefficiency. Fix confirmed checkpoint bottlenecks only; no speculative UI/MCP/config changes, providers, dependencies or evidence-milestone expansion. Preserve inherited tracked/untracked evidence work.
- **Implementation:** `src/checkpoints/core.ts` loads metadata with bounded, call-local `cat-file` batches and validates commit/worktree/staged-parent relationships and tree types. No persistent validation cache; restore still reloads its target. `src/checkpoints/index.ts` batches branch and redo loading and propagates cancellation into batch/retention Git operations. Unchanged ordinary captures deduplicate before commit/ref persistence, compare coverage/exclusions as well as trees/scope, and verify the retained ref. Recovery backups remain fresh. Unchanged index records and tree diffs avoid redundant work; shell/codemode dirtiness and raw-byte verification remain conservative.
- **Regression checklist:** [x] batch boundaries/process count and fresh ref validation; [x] partial missing/corrupt metadata, non-commit refs and staged-parent mismatch; [x] no commit/ref writes for unchanged captures; [x] exclusions, coverage/scope, raw/staged changes, missing retained refs, cross-session and recovery safeguards; [x] controller branch/redo resume and cancelled startup; [x] final check/full suite.
- **Measured local result:** the same saved session's 50-checkpoint read-only listing fell from 12,694 ms / 251 Git subprocesses to 1,152 ms / 15 subprocesses. A single before/after observation, not total startup or UI latency, and not a general benchmark. No capture/restore in this comparison. Output: ignored `.artifacts/checkpoint-performance/listing-result.json` and Git trace.
- **Final validation:** focused checkpoint tests exited 0: 21 total, 20 passed, 0 failed, 1 skipped. `npm run check` exited 0 (Biome checked 92 files with no fixes; TypeScript passed). `npm test` exited 0: 193 total, 192 passed, 0 failed, 1 skipped, 0 cancelled/todo. The checkpoint symlink test skipped because this host cannot create symlinks; original totals and skip inspected. Logs `.artifacts/checkpoint-performance/{focused,check,test}.log`. Auto log triage was local over 205 lines: 0 provider attempts, 38 ms total / 0 ms provider wait. Actual command exits were captured separately. `git diff --check` exited 0 with informational LF-to-CRLF warnings. No production/test code changed after final validation; subsequent changes only record these results.
- **Unresolved / release boundary:** actual fullscreen/reload behavior and the flickering root cause remain unverified. No manual UI/provider checks performed. Existing evidence milestone release blockers and deferred features are unchanged; this maintenance task does not claim evidence workflow/model benefit or overall Pi startup improvement.

### Future handoff template

```text
Handoff number / date:
Phase and status:
Scope completed:
Changed files:
Pre-existing/unrelated changes to preserve:
Decisions and reasons:
Validation commands and actual results:
Checks not run / release gates still open:
Known failures or uncertainty:
Next concrete action:
```

## 17. Completion criteria

The initial milestone is complete only when its included features, compatibility work, tests, and documentation meet their acceptance gates. The full roadmap is complete only when each phase is complete or explicitly closed as deferred/out of scope with a reason and user agreement where consequential.

- [ ] Capacity pressure no longer leaves users without a supported correction path.
- [ ] Provenance and branch-local lifecycle integrity survive corrections, rollover, reload, and navigation.
- [ ] Claims, gaps, and review reasons have clear, tested semantics.
- [ ] The opt-in workflow guides useful investigation and permits honest stopping.
- [ ] The pre-answer audit reports structural/freshness limitations without claiming truth verification.
- [ ] Receipt counts cannot reasonably be mistaken for substantive support coverage in the shipped presentation.
- [ ] Legacy compatibility, bounds, privacy, and cancellation guarantees are preserved.
- [ ] Automated validation passes; manual/runtime gates are completed or explicitly retained as release blockers.
- [ ] README and tool/skill help describe actual shipped behavior.
- [ ] Any reasoning-benefit claim is supported by evidence; otherwise benefit remains explicitly unmeasured.
- [ ] Remaining optional work is visibly deferred rather than implicitly called complete.
