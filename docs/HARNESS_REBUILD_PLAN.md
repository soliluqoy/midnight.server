# midnight.server: rebuild plan

Status (2026-09-27): rewritten from first principles around one question: how close can a fast model (GPT-6 Luna) get to a strong one (GPT-6 Astra, thinking high) on hard repository work, and at what latency and cost? This replaces the earlier phase plan. Everything that does not serve that question was removed in the same change (Section 4).

Update (2026-09-28): [WORKFLOW_PLAN.md](WORKFLOW_PLAN.md) now sets the product defaults: a lean harness measured against plain Pi. Features this plan lists as kept but that are now removed or opt-in are listed there. The measurement steps below still apply.

Update (2026-09-27, later): [LUNA_DESIGN.md](LUNA_DESIGN.md) derives the design decisions from existing data without running a model. Its main result changes the order of Steps 4 and 5 below: build the verifier (requirement receipts, mutation kill rate, targeted tests) before search, because search behind today's visible checks is predicted to add at most 3 points.

## 1. Goal and claim

Target claim, stated before any tuning:

> Luna with midnight.server is within 5 success points of Astra high on fresh repository tasks, with latency and cost reported alongside.

This is a target, not an established result. "Within 5 points" is a non-inferiority test: the lower bound of the 95% cluster-bootstrap interval for (Luna success - Astra high success), resampling task families, lies above -5 points. A point estimate inside 5 points with a wider interval is "not shown", not "almost".

Reported with every claim:

- Success at equal budget, and success plotted against wall time, tokens and dollars.
- The gap between visible tests and the hidden grader.
- Silent drift (claims success, hidden grader fails, nothing disclosed) as its own rate.
- For any run where a stronger model advised: the advice model, number of calls and cost.

## 2. What the evidence says now

- The four starter tasks are saturated: Luna with and without the harness and Astra without it all scored 12/12 (`evals/harness/RESULTS.md`). They cannot show a gap.
- The drift pilots used 15 short tasks. Their Astra reference ran with the harness off, so all four of its failures were edits to a test it was not told was protected. Astra with the harness was never run (`evals/drift/RESULTS.md`).
- `drift-db-unavailable` was contaminated from pilot 01 on: an earlier run left a stub database server on the task's port. A fresh file workspace is not isolation.
- Pilot 01 showed the harness's own repair loop can cause drift: repeated "fix the checks" feedback on a test that contradicts the request produced a test-specific special case. `blockerExit` removed it in pilot 02 (4/4 correct with it, 0/4 without).
- The `task` contract added 73% tokens on Luna with no measured gain. Base Laya review was at chance on held-out tasks (`evals/laya-review` results, summarized in Section 4).

Conclusion: the rebuild has good failure mechanisms but no measurement of the Luna-Astra gap on hard work. Measuring it comes first.

## 3. First principles

A coding run succeeds when four things hold. The harness exists to make each one cheaper in code than in model tokens:

| Condition | Failure when missing | Harness lever |
| --- | --- | --- |
| The model sees the right evidence | Wrong files, misunderstood requirement | Context acquisition (Step 2) |
| Edits land as intended | Broken syntax, misapplied edit, wrong path | Edit gate and repair (Step 3) |
| Feedback is precise and does not fight the request | Ineffective repair, test-specific workaround | Diagnostics and blocker rule (Step 3), spec receipts (Step 5) |
| Budget goes where it helps | Timeout on a correct approach, waste on easy tasks | Selective search (Step 4), whole-run optimization (Step 6) |

Rules that follow:

1. A feature exists only if it maps to one of these rows and is measured. Unmeasured features stay behind a flag until measured; features measured neutral-or-worse at their cost are removed.
2. Measure the failure before building for it. The failure classes from Step 1 order the work.
3. Stop scaffolding a failure class when oracle probes show Luna still fails with the correct files, the exact failing assertion and a clean chance to repair (Section 7). That is where a stronger model, or a measured cascade, earns its place.
4. Keep claims separable: pure Luna, Luna with more test-time compute, and a cascade with a stronger model are different results.

## 4. What this rebuild removed

| Removed | Why |
| --- | --- |
| Local MiniCPM5-2B model: `--local`, `--hybrid`, `delegate_local`, helper tasks, drift watch, engine download and pins, `native/midnight-host`, model lock files, `model`/`engine`/`doctor`/`helper` subcommands, local fallback, local side-thread choice | Not on the path to the goal. On CPU a 2B model could not act on check feedback and each turn cost minutes (`evals/drift/RESULTS.md`). |
| Built-in `llama.cpp` server provider extension | A local-model connector; same reason. |
| `local` model class and `localProfile` feature (output caps, greedy decoding, core-tools-only) | Only served the local model. |
| `contract` feature (`task` tool) | +73% tokens on Luna, no measured gain; off everywhere already. |
| `decisions` feature (Laya intake and completion review) | Base Laya was at chance (AUC 0.37-0.52) on held-out review questions. The two review questions with exact signals (weakened tests, unsupported success claims) are already covered deterministically by `driftGuard`. |
| `evals/laya-review/` | Experiment for the removed feature. Result kept here: base Laya had no signal; fitted Laya Studio readers reached AUC 0.76-0.94 but with uncalibrated probabilities; text rules answered weakened-tests and unsupported-claims exactly. |
| Local-model release packaging and docs (`fetch-model`, `verify-model`, engine pin generator, CPU inference spike and benchmark notes) | Nothing left to package. |

Kept, each tied to a row of Section 3: `contextPack`, `lookup`, `diagnostics` (evidence); `parseGate`, `editRepair`, `pathHints`, `loopGuard` (edits); `inRunChecks`, `checkpoints`, `driftGuard`, `blockerExit` (feedback); `masking`, `escalation` (budget). Also `evals/sensitivity-lab/` for analyzing controlled feature interactions (not as a runtime rule), and `evals/drift/`.

## 5. Modes and claims

| Mode | Behavior | Claim it supports |
| --- | --- | --- |
| Luna fast | Retrieval, one trajectory, immediate checks, bounded repair | Pure Luna quality and speed |
| Luna search | Fast plus isolated parallel attempts on triggered tasks (Step 4) | Pure Luna with more test-time compute |
| Assisted | A stronger model gives advice on defined failure states | Quality and cost of a model cascade |

Decision (2026-09-27): escalation stays on by default in the product, so a default session is Assisted whenever the escalation model has credentials. Consequences:

- Every eval arm that supports a pure-Luna claim sets `-escalation` explicitly, and the runner refuses to label a run "Luna fast" or "Luna search" if an `escalation` event appears in its telemetry.
- Every run receipt records the advice model, calls, tokens and cost (Section 8), including zero.

## 6. Build sequence

Each step lists what it builds, what it measures and when it is done. Steps 2-6 are ordered by the failure classes Step 1 finds; the order below is the expected one.

### Step 0. Measurement prerequisites

Nothing after this is interpretable without it.

1. **Fresh holdout, frozen before tuning.** Independent repository families (not variants of one task), written after the models' training cutoffs or from private code. Include longer multi-file tasks (a feature across modules, an interface change and its callers, a bug that needs a reproduction first) and specification traps (a visible test that under-specifies or contradicts the request). Split dev and holdout by family. Size the holdout by a power calculation for the non-inferiority margin in Section 1; expect at least 30 families.
2. **Per-run isolation.** Each run gets its own workspace, process group and ports; the runner kills the process tree at the end and fails the run if a declared port was open at start (`environmentContaminated`) or left open (`environmentLeak`). Extend what exists (`closedPorts`) to every task that touches a service.
3. **Run receipt v2** (Section 8): per-phase timing and escalation cost. Today escalation cost is computed in `escalate.ts` but not written to the receipt, and no per-phase timing exists.
4. **Pinned settings.** Model IDs, reasoning level, harness commit, task version, grader version, time limit and budget per arm, recorded in the experiment manifest (`scripts/harness-eval-design.mjs`).

Done when: the holdout exists and is frozen, every task validates (`scripts/harness-eval-validate.mjs`: start fails the grader, reference passes), and a dry run of all arms on the scripted model produces complete receipts.

### Step 1. Establish the gap

Run the dev split through four arms: Luna bare, Luna + harness (`-escalation`), Astra high bare, Astra high + harness. At least 3 repeats.

For every task Astra solves and Luna fails, label the first fatal mistake from the trace:

- wrong files (localization)
- misunderstood requirement
- faulty edit
- ineffective response to a test failure
- missing dependency or environment
- correct approach that ran out of time or budget

Done when: the gap per arm is measured with intervals, and the labeled failures form a ranked queue. That queue, not this document, decides the order of Steps 2-6.

### Step 2. Context acquisition as a subsystem

Keep the ranked context pack and `lookup`. Add:

1. Structural links: implementation to callers, tests, configuration, and to locations named in error traces.
2. Retrieval in small, expandable chunks with source locations, instead of whole files.
3. Measurement per run: recall of the files the reference solution touches (known from `evals/harness/reference/`), irrelevant tokens delivered, and turns to the first correct edit.

A search hit that looks plausible is not evidence the model found what it needed; file recall is.

Done when: recall and turns-to-first-correct-edit improve on dev without a solve-rate drop, or the measurement shows retrieval is not the bottleneck for Luna's failures.

### Step 3. Tighten the edit-verify loop

Keep the syntax gate, edit repair, in-run checks, checkpoints and `blockerExit`. Change the feedback:

1. Return the smallest actionable diagnostic: the failing assertion, the implicated function with nearby lines, and whether the failure existed before the edit (run the failing check against the checkpoint).
2. Cheap checks immediately after an edit batch; broader integration checks at meaningful checkpoints (settle, or after a set of related edits), not every turn.
3. Keep the original request in view when feedback conflicts with it. Pilot 01 is the counterexample to avoid; pilot 02's blocker rule is the current fix.

Done when: the "ineffective response to a test failure" class shrinks on dev and silent drift does not rise.

### Step 4. Selective search over solutions

Default is one trajectory. Launch 2-3 independent Luna attempts in isolated workspaces only on a concrete uncertainty signal:

- two failed repair rounds on the same checks;
- incompatible plausible interpretations of the request (detected, not guessed: e.g. candidate edits touching disjoint files for the same requirement);
- a large change with weak test coverage of the changed code.

Select by specification coverage (Step 5), unchanged-file rules, focused and integration checks; in the eval, the hidden grader judges only after selection. Allow one revision with precise feedback. Cap the extra budget per task.

Done when: search solves more tasks per minute and per dollar than letting the first trajectory continue for the same budget. If it does not, it stays off.

### Step 5. Verification built on the specification

Visible tests alone are a dangerous selector: agents pass visible suites while failing held-out specification checks, more so on longer tasks.

1. Requirement receipts: for each requested behavior, whether the change implements it, the evidence (check, file and line), and which requirements remain unverified. Derived by the harness from the request; not a model-written contract (Section 4).
2. Test protection stays; changes to tests are shown as suspicious (already in `driftGuard`).
3. Generated edge-case tests only where the expected behavior follows directly from the specification.
4. An honest blocker is a recorded outcome, not a failure to hide.

Done when: the visible-test versus hidden-grader gap shrinks on dev.

### Step 6. Optimize the whole run

Instrumentation lands in Step 0; optimization happens here.

1. Cache the repository index and the stable prompt prefix; update only changed-file summaries.
2. Do not rerun checks whose inputs did not change; run independent checks in parallel where safe.
3. A per-task budget controller: extra retrieval or search branches are bought only when their expected benefit exceeds their latency and cost, estimated from dev receipts.

Done when: wall time and dollars per solved task drop on dev with success unchanged.

## 7. Oracle probes: the stopping rule

For each failure class Step 1 finds, run controlled probes on the failing tasks: give Luna the correct files, the exact failing assertion, and a clean repair opportunity from a correct checkpoint. If Luna still fails, more scaffolding for that class is not worth building; the answer is a stronger model or a measured cascade (Assisted mode). If Luna succeeds, the class is a harness problem and its step proceeds.

## 8. Run receipt

Every eval run writes one receipt (JSONL) with:

- identity: task, family, split, arm, repeat, seed, model and reasoning level, harness commit, task and grader version;
- resolved features (checked against the arm's assignment, as today);
- outcome: hidden grader, visible checks, requirement-level grading, completion, timeout, budget stop, blocker reported, silent drift, `environmentContaminated`, `environmentLeak`;
- cost: input, output, cache-read and cache-write tokens; list-price dollars;
- escalation: advice model, calls, tokens and dollars (zero when none);
- time by phase: workspace setup, indexing and context pack, model prefill and decode (from provider timing where available, else request wall time), tool execution (shell, checks, repairs);
- retrieval (Step 2): files delivered, recall of reference files, turns to first correct edit;
- search (Step 4): attempts launched, trigger, which attempt was selected and why.

## 9. The gate for "almost Astra"

1. Freeze the holdout (Step 0) before any tuning; touch it only at this gate.
2. Arms: Luna fast, Luna search, Astra high bare, Astra high + harness, and Assisted if claimed. Equal budget per arm, stated.
3. Report success with cluster-bootstrap intervals over families, success against wall time, tokens and dollars, the visible-versus-hidden gap, and silent drift.
4. The claim in Section 1 holds only if the non-inferiority bound holds for Luna search against the better of the two Astra arms.
5. Alongside the private holdout, run a recognized long-horizon public benchmark, with the caveat that task defects and contamination can distort public scores.

## 10. Not doing now

- A general model reviewer: base Laya was at chance, and the deterministic drift checks already cover the exact signals.
- Runtime rules from the sensitivity lab: its success rates are noisy estimates, not Boolean functions with exact sensitivity or degree. Use the lab to analyze controlled feature interactions, then confirm chosen policies on new families.
- Per-model prompt wording search, learned routers, formal verification, tree-sitter adoption: revisit only if a failure class from Step 1 points at them.

## 11. Decisions

| Decision | Chosen | Date |
| --- | --- | --- |
| Target and reference models | GPT-6 Luna (target), GPT-6 Astra thinking high (reference) | 2026-09-27 |
| Claim threshold | Non-inferiority, margin 5 points, cluster bootstrap over families | 2026-09-27 |
| Local model | Removed entirely | 2026-09-27 |
| Escalation default | On in the product; off in pure-Luna eval arms; always on the receipt | 2026-09-27 |
| Task contract | Removed | 2026-09-27 |
| Laya review | Removed | 2026-09-27 |
| Holdout size | Set by power calculation in Step 0 | |
| Per-task search budget cap | Set from dev receipts in Step 4 | |

## 12. Working rules

- Every change ships behind a feature flag, is measured on dev, and is judged on holdout only at the gate.
- `AGENTS.md` applies: `npm run check` after code changes, tests through `./test.sh` or single vitest files, faux provider for suite tests, no dependency without lockfile and shrinkwrap review.
- Eval results are evidence for gates; unit and suite tests are evidence for correctness. Neither replaces the other.
