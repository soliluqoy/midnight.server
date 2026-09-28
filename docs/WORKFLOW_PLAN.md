# Workflow plan: a lean harness that has to beat vanilla Pi

Status (2026-09-28): proposal. It replaces the feature-accumulation approach of [HARNESS_REBUILD_PLAN.md](HARNESS_REBUILD_PLAN.md) for the product's default behavior. The measurement goals of that plan (Luna vs Astra) stay; this plan changes what runs in a user's session while they are measured.

## 1. Problem

The harness adds work to every request, on the critical path, without evidence that it pays for itself. Vanilla Pi (four tools, short system prompt, the model runs its own tests) is the bar, and the harness has never been measured against it on wall time or on cost including prompt cache.

### What one request does today

A three-edit TypeScript change with detected checks, fast model, defaults on (`features.ts` class defaults: 18 of 19 features on):

| Phase | Harness work | Blocks the model? | Where |
| --- | --- | --- | --- |
| Request start | `git write-tree`, index refresh, git summary, context pack or follow-up pack, then baseline static checks (types, lint) over the project | The first edit or shell call waits up to 15 s for the baseline | `extension.ts` `before_agent_start`, `tool_call`, `BASELINE_WAIT_MS` |
| Each edit | Parse gate, then language-server sync of the new file and of the old content, each waiting up to 8 s for diagnostics | Yes, the tool result waits | `diagnosticsNote` |
| Each turn after an edit batch | Check ladder up to level 2 (types, lint, related tests), result injected as a message | Yes, the next model call waits | `turn_end` |
| Every turn | Observation masking rewrites old tool results | No, but it changes history | `masking.ts` |
| Settle | Ladder up to level 3 (full tests), up to 2 repair rounds, divergence diff and archive, reasoning boost, rollback, escalation to `claude-opus-5-5`, drift inventory and nudge, optional mutation probe | Yes | `settle` |
| After settle | Lattice records the request; may start, judge or roll back a live policy trial that changes features for the next session | No | `agent_settled`, `lattice/harness-policy.ts` |

Each piece is reasonable alone. Together they mean the model waits on the harness several times per request, receives unrequested messages mid-plan, and runs with a feature set that can change between sessions.

### Why it does not save tokens or time

1. **Cache-hostile history.** Providers bill cached input at a fraction of the normal price, and the cache only covers an unchanged prefix. Masking replaces old tool results, so every masking batch invalidates the cache from the first elided result onward and the rest of the context is billed at full price again. The harness results tables report input tokens and cache reads separately and never priced them together, so the claimed saving is unmeasured and can be negative.
2. **Duplicate verification.** The harness runs checks mid-run and at settle, and models often run the tests themselves as well (not yet counted in any receipt). The in-run message says "you do not need to rerun them", which is a request, not a guarantee.
3. **Extra turns.** Every injected message (in-run check result, repair round, drift nudge, divergence note, escalation advice) is a new model turn with the full context.
4. **Tool-schema and prompt overhead.** The `lookup` tool, the blocker guideline and the context pack are sent on requests that do not need them.

### Why it does not improve accuracy measurably

- Every measurement is on short tasks in repositories of 2 to 21 files (`LUNA_DESIGN.md` section 2). Bare Luna already solves them (`evals/harness/RESULTS.md`: 12/12 bare vs 12/12 harness at +73% tokens, before the contract was removed).
- Drift pilots: harness off 98% of requirements met vs 91% for the harness with neither drift feature, in both pilots (`evals/drift/RESULTS.md`). The only feature with a consistent positive signal is `blockerExit`, and it fixes a failure the harness's own repair loop created (pilot 01, `drift-email-conflict`: harness off 2/2, every harness arm 0/8).
- `mutationProbe`, `divergence`, `reasoningBoost` and the policy loop have no model measurement at all (`IMPLEMENTATION_STATUS.md`).
- All 17 hidden failures in the pilots passed the visible checks (`LUNA_DESIGN.md`): more check rounds cannot find what the checks do not test.

### Why it is hard to reason about

- 19 feature flags, resolved from class defaults, the Lattice policy, `harness.json` and the environment (`resolveFeatures`). A user cannot tell which set a session ran.
- The policy loop runs trials on live sessions, so two sessions on the same project can behave differently by design.
- `harness/` is about 7,100 lines with `extension.ts` at 1,700; `lattice/` is about 11,300 lines, part of which ships in the binary.

## 2. Principles

1. **Vanilla Pi is the default baseline.** A behavior is on by default only if a receipt shows it beats `MIDNIGHT_SERVER_HARNESS=0` on success, or matches it on success and wins on wall time or dollars (cache included).
2. **Nothing slow on the critical path.** Work that runs while the model waits must take milliseconds (pure functions over the tool call and the file it touches). Anything that spawns processes runs once, at settle.
3. **Append-only context.** Never rewrite history. Use Pi's compaction when the window fills; it resets the cache once instead of repeatedly.
4. **Speak once.** No messages mid-run. At most one follow-up turn per request from the harness, and only for a concrete failure.
5. **Same behavior every session.** No live experiments in the product. Experiments run in the eval runner.
6. **Stop cleanly.** A model that reports an honest blocker is done (the pilot-02 rule).

## 3. The lean workflow

```
request ──► model loop (vanilla Pi) ──────────────────────────► settle ──► done
              │ tool_call / tool_result guards (ms, inline)       │
              │  path remap, PowerShell repair, protected files   │ one verification pass
              │  edit indentation repair, not-found hint          │ drift guard (static)
              │  path "did you mean", parse gate                  │ at most one repair turn
```

### Session start (once)

Detect the environment and check commands (`detect-checks.ts`) and put the facts (OS, shell, how to run types, lint and tests) in the system prompt. They are stable for the session, so they sit in the cached prefix and cost nothing after the first request. No per-request pack.

### During the run: inline guards only

Kept, because each is a pure function that either fixes a tool call or adds one line to a result the model is already waiting for:

| Guard | Source | Why |
| --- | --- | --- |
| Foreign-path remap, PowerShell `/dev/null` repair | `interface-repair.ts` | Removes a guaranteed failed call |
| Protected files | `extension.ts` `tool_call` | Safety; free |
| Indentation repair, not-found closest-match hint | `edit-repair.ts` | Removes a retry turn |
| Path "did you mean" | `edit-repair.ts` | Removes a search turn |
| Parse gate | `parse-gate.ts` | Keeps a broken file from reaching later turns; keep only if its measured latency per edit stays under 50 ms, else move it to settle |
| Loop note (repeated identical call or failing command) | `LoopGuard` | One line on the result; no extra turn |

Removed from the run: baseline checks at request start, in-run check ladder, per-edit language-server diagnostics, masking, reasoning boost, mid-run escalation.

### Settle: one verification pass

1. Take the changed files (git diff against a `git write-tree` taken at request start, which is cheap and non-blocking).
2. Run the cheapest checks that cover them: types and lint, then related tests. The full suite only if `harness.json` asks for it.
3. All pass: run the drift guard (static, measured precise, costs nothing when silent). One nudge at most.
4. A check fails: classify pre-existing failures lazily, only now, by running that one check against the start tree in a temporary worktree. New failures get **one** repair turn carrying the smallest actionable output (failing assertion, file and line) and the blocker rule. If the model then reports a blocker or the checks still fail, stop and tell the user.
5. Skip the pass when the model already ran the same check after its last edit with exit code 0 (the `TEST_COMMAND` match and `verifiedAt` exist today).

Removed from settle: second repair round, rollback, divergence archive, reasoning boost, escalation, mutation probe.

### Opt-in, off by default

`contextPack`, `lookup`, `escalation`, `mutationProbe`, LSP diagnostics. Each stays available in `harness.json` for users and the eval runner, and returns to the default only through Section 5.

## 4. Changes by file

| Area | Change | Size |
| --- | --- | --- |
| `features.ts` | One default set for both classes: `parseGate`, `editRepair`, `pathHints`, `loopGuard`, `settleChecks`, `checkBaseline` (lazy), `driftGuard`, `blockerExit`. Remove `inRunChecks`, `checkpoints`, `adaptiveRepair`, `divergence`, `reasoningBoost`, `masking` as features. Drop the model-class split unless a receipt justifies it. | Small |
| `extension.ts` | Split into `guards.ts` (tool_call/tool_result) and `settle.ts` (verification pass). `before_agent_start` does only `write-tree` in the background and the one-time facts. Target under 600 lines combined. | Medium |
| `baseline.ts` | Run on the failure path against the start tree, not at every request start. | Small |
| `checks.ts` | Single pass, `maxRepairRounds` default 1, reuse the model's own passing run. | Small |
| `masking.ts`, `divergence.ts`, `checkpoints.ts` rollback, `mutation.ts` in the runtime | Delete from the product; `mutation.ts` can move to `evals/` if still wanted. | Deletion, needs approval |
| `lattice/harness-policy.ts`, `policy.ts` | Remove the live policy loop from the product. The standalone `npm run lattice` kernel stays as a research tool outside the binary. | Deletion, needs approval |
| `escalate.ts` | Off by default; when on, only at the end of the single failed repair turn. | Small |
| Docs | `README.md` harness paragraph, `packages/coding-agent/docs/harness.md`, `IMPLEMENTATION_STATUS.md`, changelog. | Small |

Expected result: `harness/` from about 7,100 lines to about 3,000, no Lattice code in the session path, 8 flags instead of 19.

## 5. Measurement that decides defaults

The comparison the project has not run: lean vs current vs vanilla Pi, on the same tasks, with the numbers a user feels.

1. **Receipt additions** (`scripts/harness-eval.mjs`): wall time; time spent inside harness hooks, per hook (wrap each handler with a timer and record it in `telemetry.ts`); cost priced with cache reads and writes; cache hit rate; model turns; harness-injected turns.
2. **Tasks.** The existing 38 small tasks stay as a regression set. Add at least 10 tasks in real, larger repositories, including this monorepo, where a change crosses files and the full test suite takes more than a few seconds. These are where the per-request overhead shows.
3. **Arms.** `vanilla` (`MIDNIGHT_SERVER_HARNESS=0`), `lean` (Section 3), `current` (today's defaults, `-escalation`). Luna and one frontier model. 3 repeats.
4. **Gate for lean becoming the default:** success not below vanilla by more than the interval allows, median wall time within 10% of vanilla, dollars per solved task at or below vanilla. If lean does not beat vanilla on at least one of success or cost, the default becomes vanilla plus the inline guards only.
5. **Adding a feature back** (any opt-in above, or a new one) requires the same receipt: an ablation against lean that improves success or cost without losing on the other. Unmeasured features ship off.

## 6. Order of work

1. Instrument hook timing and cache-inclusive cost in telemetry and the receipt. Run `vanilla` vs `current` on the small set and a few large-repo tasks to confirm where time and money go. (Small; confirms or corrects Section 1 before deleting anything.)
2. Flip the defaults to the lean set with flags only, no deletions. Ship behind `MIDNIGHT_SERVER_HARNESS_PROFILE=lean` first, then make it the default once the gate in Section 5 holds.
3. Restructure `extension.ts` into guards and settle; move baseline to the failure path; single repair round.
4. With approval, delete the removed features and take the policy loop out of the session path.
5. Update docs and changelog; re-run the receipt on the release candidate.

## 7. Decisions needed

| Question | Proposed |
| --- | --- |
| Delete masking, divergence, rollback, mutation probe and the live policy loop, or keep them behind flags? | Delete from the product; keep eval-only code where it has research value |
| Escalation default | Off; opt-in with its cost shown in `/harness` |
| Context pack and `lookup` default | Off until a large-repo receipt shows a gain |
| Keep the fast/frontier split | Only if a receipt shows different best defaults per class |
