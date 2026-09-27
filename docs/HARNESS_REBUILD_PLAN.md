# midnight.server: harness rebuild plan

Status (2026-09-26): phases 1-8 and 12 are implemented in their first version, and phase 10 option C is decided: the local model is off the default path (`delegate_local` and drift watch need `--hybrid`); a small local embedding model is not added yet (the model host was unreachable during the build, and BM25 ranking has not yet been shown to be the bottleneck). Phase 9 (per-model wording search) and the model runs behind every gate are not done: no model was available in the build environment. The typed decision layer uses Laya (open-source, local, `/v1/systemone` protocol), so nothing leaves the machine; its thresholds are uncalibrated until the eval runs. See `evals/harness/RESULTS.md` and `packages/coding-agent/docs/harness.md`.

Update (2026-09-27, later): the first measured experiments ran, aimed at implementation drift (`evals/drift/`, results in `evals/drift/RESULTS.md`). Phase 1 runner gaps are closed for them: an experiment manifest with complete per-arm feature assignments, resolved-feature receipts, separate outcome fields (artifact, completion, timeout, budget), requirement-level grading, `--resume`, and export to the sensitivity lab (`evals/sensitivity-lab/`) for factorial analysis. The Laya review is off by default (at chance in `evals/laya-review`). Two drift features are on by default: `driftGuard` (deterministic detectors, one fix-or-disclose turn) and `blockerExit` (a sanctioned stop, including in the repair loop). It builds on the research in this session: the audit of `src/harness/` and `src/midnight/`, and the direction that the harness should do in code what a fast model would otherwise do in tokens.

## 0. How to read this plan

- Phases are ordered by dependency. A phase does not start until the previous phase's exit criteria are met, except where marked "can run in parallel".
- Every change ships behind a flag, is measured against the eval (Phase 1), and is kept only if the numbers support it. "Measured" means the eval and statistics in Phase 1, not a single run.
- Each phase lists: goal, why, work items, deliverables, tests, exit criteria, risks. Decision gates (G1-G6) are points where we stop and decide with data.
- Repository rules in `AGENTS.md` apply to every step: `npm run check` after code changes, tests through `./test.sh` or single vitest files, the faux provider for suite tests, no dependency added without lockfile and shrinkwrap review, ask before removing intentional functionality, no commits unless asked.

## 1. Goal and success metrics

### 1.1 Goal

Make fast, cheap, weaker models (target class: GPT-6 Luna, DeepSeek V4.1 Flash) solve coding tasks at a rate close to a strong model, while spending no more tokens than they spend today without the harness. No `/skills`, no task-specific prompts: the gains must come from the built-in harness.

### 1.2 Principle

Tokens per run are roughly the sum over turns of the context sent that turn, plus output. Turns dominate because the context is resent each turn. A harness saves tokens only by removing turns or shrinking context, which means doing work in code that the model would otherwise do in tokens:

| Model work today | Replaced by |
| --- | --- |
| Exploring the repo (ls, find, grep, reading whole files) | Context pack computed before turn 1; semantic lookup tools |
| Recovering from broken edits, wrong paths, bad commands | Validation at the moment of action; deterministic repairs |
| Deciding whether it is done; over- or under-verifying | Harness-owned verification ladder and stop rule |
| Reasoning its way past a hard step it cannot solve | Escalation of that step to a stronger model |

Features that add model work (the current task contract) must pay for themselves in measured solve rate, or be removed from the default path.

### 1.3 Metrics

Primary, per model and variant, on the hard eval set:

1. **Solve rate** (hidden-test pass rate, pass@1).
2. **Tokens per solved task** (input + output + cache reads priced separately; also list-price cost).
3. **Wall time per solved task.**

Secondary ("feels smarter"):

4. **False-done rate**: runs that end claiming success while hidden or visible tests fail.
5. **Dumb-error count** per run: tool-call argument errors, nonexistent paths, edits that break parsing, commands that fail for environment reasons (PowerShell vs POSIX), hallucinated symbols.
6. **Turns per run** and **turns before first edit**.
7. **Turn category breakdown**: explore, edit, verify, recover, chat.
8. **Escalation rate and escalated-token share** (Phase 8 onward).

### 1.4 Targets

Set after the Phase 1 baseline, then fixed before building features, so they cannot move to fit results. Proposed shape:

- Hard set solve rate: Luna + harness closes at least 50% of the gap between Luna bare and the strong reference model bare.
- Tokens per solved task: Luna + harness at or below Luna bare.
- False-done rate: halved against Luna bare.
- No regression: the strong reference model + harness solve rate is not lower than it is bare, and its tokens per solved task do not rise by more than 10%.

## 2. Scope decisions

In scope:

- The model-agnostic harness in `packages/coding-agent/src/harness/`.
- The eval system in `scripts/harness-eval.mjs` and `evals/harness/`.
- Per-model profiles for the target fast models and at least one strong reference model.
- Escalation from a fast model to a strong model within a session.

Out of scope for the main track (Phase 11 research track only):

- Formal verification beyond using existing checkers in repos that already use Dafny, Lean or Verus.
- Adopting Bend2, JEPA or learned world models.
- Fine-tuning cloud models (not possible) or the local model.

Needs a decision from the user at G0 (see Section 4): the role of MiniCPM and the `src/midnight/` features. Nothing is removed without explicit approval.

## 3. Phase overview

| Phase | Name | Depends on | Can run in parallel with |
| --- | --- | --- | --- |
| 0 | Decisions and baseline freeze | - | - |
| 1 | Measurement system (eval v2) | 0 | - |
| 2 | Fix existing harness defects | 1 | 3 |
| 3 | Harness kernel: profiles, flags, telemetry | 1 | 2 |
| 4 | Context engineering | 3 | 5 |
| 5 | Validation at the moment of action | 3 | 4 |
| 6 | Semantic tools (LSP, syntax trees) | 4, 5 | 7 |
| 7 | Verification ladder, auto-checks, stop rule, rollback | 5 | 6 |
| 8 | Escalation cascade | 7 | 9 |
| 9 | Per-model optimization | 6, 7 | 8 |
| 10 | Local model repositioning | G0 decision, 3 | any |
| 11 | Research track | - | any, time-boxed |
| 12 | Release, documentation, defaults | all kept features | - |

Decision gates: G0 (after Phase 0), G1 (after Phase 1 baseline), G2 (after Phase 2), G3 (after Phases 4 and 5), G4 (after Phase 7), G5 (after Phase 8), G6 (before release).

## 4. Phase 0: decisions and baseline freeze

Goal: agree on what we optimize and freeze the starting point.

Work items:

1. Pick the model roster and pin exact IDs and providers:
   - Target fast models: Luna and DeepSeek V4.1 Flash (confirm provider IDs; neither ID is in the committed `models.generated.ts`, so confirm how they are configured, e.g. `openai-codex/...` and a DeepSeek provider).
   - Strong reference: one frontier model (e.g. the model used as "Astra" in `evals/harness/RESULTS.md`).
   - Local model: MiniCPM5-2B, only if G0 keeps it in scope.
2. Fix thinking/reasoning levels per model for the eval (e.g. Luna at the level users will run it). Record them in the eval config.
3. Decide the eval budget: dollars per full eval run, and how often full runs happen (every gate) versus smoke runs (every PR touching the harness).
4. Tag the current commit as the baseline (`harness-baseline-2026-09`), so every later result compares against a fixed reference.
5. G0 decision on MiniCPM (see Phase 10 for the options). Record it in this document.
6. Decide the telemetry policy: all run data stays local; nothing is uploaded; users can opt in to export anonymized traces for eval building (or not at all).

Deliverables: a filled "Decisions" table at the end of this document (Section 19).

Exit criteria: the roster, budgets and G0 decision are written down.

## 5. Phase 1: measurement system (eval v2)

Goal: an eval that can tell whether a harness change helps a fast model, with enough tasks and repeats to trust a difference. Everything later depends on this phase.

Why: the current four tasks are solved 12/12 by Luna bare, so they cannot show a gain. The local run had one repeat.

### 5.1 Task corpus

1. Size: 60-100 tasks for the main set, split into:
   - **dev** (about 60%): used while building and for automatic prompt optimization (Phase 9).
   - **holdout** (about 40%): run only at gates. Never used to tune anything.
2. Difficulty calibration: target Luna bare pass rate of 30-60% on the main set. Keep tasks the strong model solves; drop tasks nobody solves (they measure nothing) and tasks everyone solves (keep a few as a sanity subset).
3. Categories, each with at least 6 tasks:
   - Localized bug with a failing test (sanity).
   - Bug without a failing test (must reproduce first).
   - Implied requirements (`port-intent` style).
   - Underspecified requests with a standard answer (`csv-quotes` style).
   - Test traps (tempting to edit the test).
   - Multi-file changes (rename across modules, change an interface and its callers).
   - Feature additions to an existing module with conventions to follow.
   - Refactors that must not change behavior (graded by differential tests).
   - Navigation-heavy tasks in a medium repo (500-5,000 lines, where exploring costs real turns).
   - Environment traps: Windows paths, PowerShell, missing tools, long-running commands.
   - Type errors and lint failures (TS strict mode).
   - Tasks that need a clarifying question (graded on whether the agent asks instead of guessing; needs a scripted user reply, see 5.2).
4. Languages: TypeScript/JavaScript (most tasks), Python, and a few Go or Rust, so LSP and syntax-tree work (Phase 6) is tested on more than one language.
5. Repos: mix of synthetic small repos and snapshots of real open-source repos at fixed commits (license-compatible, vendored as tarballs or fetched by hash). Real repos catch problems synthetic ones do not: size, conventions, noisy test output.
6. Sources of tasks: bugs from our own history (this repo's commits), reverted commits in open-source repos (the fix is the reference), hand-written tasks. Every task gets a reference solution in `evals/harness/reference/` that passes its grader, and a check that the starting state fails the grader.
7. Contamination: prefer tasks written after the models' training cutoffs, or tasks from private code. Record provenance per task in `task.json`.

### 5.2 Runner upgrades (`scripts/harness-eval.mjs`)

1. **Parallel runs** with a concurrency limit and per-provider rate limiting. Local-model runs stay serial.
2. **Variants beyond on/off**: named feature sets (`--variants bare,harness,harness-no-contract,...`) mapping to flags from Phase 3, so each feature can be ablated.
3. **Repeat and seed control**: `--repeat 5` default for gates; record provider, model, reasoning level, harness commit, task commit.
4. **Per-turn accounting** from the JSON event stream: input, output, cache read, cache write per turn; tool calls per turn; time per turn.
5. **Turn categorization** by rules on tool calls: explore (read, ls, find, grep, lookup tools), edit (edit, write), verify (test and check commands, harness checks), recover (a turn after an error result), chat (no tool calls).
6. **Dumb-error detection**: count tool results with errors, classified: path not found, edit oldText not found, parse broken by edit, command not found, PowerShell syntax error, timeout.
7. **False-done detection**: the run ends with a final message and the hidden grader fails; separately, visible checks fail at end.
8. **Scripted user**: tasks may include `replies.json` so an agent that asks a clarifying question gets a fixed answer, instead of the run failing on `-p` mode.
9. **Budget guard**: stop a run above a token or dollar cap, count it as a fail with reason `budget`.
10. **Result store**: JSONL per run (as today) plus a summary per invocation; keep event streams. Results stay out of git (`evals/harness/results/` is already ignored).
11. **Report**: per-variant table with means and 95% confidence intervals; per-category breakdown; per-task pass matrix; turn category breakdown; dumb-error counts.
12. **Statistics**: paired comparisons per task (same task, both variants). Use a paired bootstrap on pass rate and on tokens per solved task; McNemar's test on per-task outcomes. Report effect size with interval, not just a p-value. Document the minimum detectable difference for the chosen task count and repeats.

### 5.3 Trace viewer

A small script that renders one run's event stream as a readable transcript with per-turn tokens and categories (terminal or static HTML). Used to diagnose failures and to build the failure taxonomy.

### 5.4 Failure taxonomy

Read at least 30 failed runs of Luna bare and label each with its first fatal mistake: wrong localization, wrong interpretation, broken edit, false done, loop, gave up, environment, budget. This decides the order of Phases 4-8 by where failures actually are.

### 5.5 Baseline

Run the full main set, 5 repeats, for: each target fast model bare and with the current harness; the strong reference bare and with the current harness; MiniCPM if in scope. Record in `evals/harness/RESULTS.md`.

Deliverables: task corpus, runner upgrades, trace viewer, taxonomy, baseline results.

Tests: unit tests for the new runner pieces (turn categorization, dumb-error classification, statistics) as plain Node tests next to the script or under `packages/coding-agent/test/` if they import harness code.

Exit criteria (G1):
- Luna bare is between 30% and 60% on the main set.
- The minimum detectable difference at 5 repeats is 10 percentage points or less.
- The taxonomy exists and names the top three failure causes.
- Targets in Section 1.4 are filled in with numbers.

Risks: eval cost (mitigate: smoke subset of 15 tasks for PRs, full runs only at gates); flaky graders (mitigate: run every reference solution and starting state 3 times in CI); tasks that leak the answer through file names or comments (review each task).

## 6. Phase 2: fix existing harness defects

Goal: remove known defects before measuring new features, so they do not hide gains or losses. Can run in parallel with Phase 3.

Each item: fix, unit test, then a small ablation on the dev set.

1. **Local compaction.** Problem: `reserveTokens` 16384 and `keepRecentTokens` 20000 against an 8192-token local window, so compaction never runs and the session overflows. Fix: model-specific compaction settings for `midnight/minicpm5-2b-q8_0` (for example reserve 1,500, keep 3,000), and a general rule that clamps both settings to fractions of any model's `contextWindow` when a configured value does not fit. Test: a faux-provider suite test with a small context window that compacts.
2. **Masking sized to the window.** Problem: 48 KB batch threshold and "keep newest 6" never trigger inside 8K. Fix: thresholds in tokens and as fractions of the model's window (for example batch at 15% of window, keep newest N where N fits in 25% of window). Keep the cache-friendly batching.
3. **Cache-aware masking for cloud models.** Problem: each masking batch invalidates the provider's prompt cache from the first edited entry. Fix: estimate the cost of the cache miss (tokens after the edit point, at the provider's uncached price) against the saving over the expected remaining turns; mask only when it pays. Record the decision in telemetry.
4. **Contract gating.** Problem: the `task` contract added 73% tokens on Luna with no measured benefit. Fix: make it conditional: off by default for fast-model profiles and small tasks; ablate on the new eval (contract on, off, and harness-written, see Phase 7.6). Keep or drop based on data, with user approval before removal.
5. **Local sampling.** Problem: greedy decoding is forced on all local requests, including thinking turns, based on one helper question. Fix: A/B vendor settings (temperature about 0.7, top-p 0.95, top-k 20) against greedy for agent turns; keep greedy for gates and classification. Only if MiniCPM stays in scope.
6. **Local slot contention.** Problem: title generation shares the single engine slot in `--local` mode and can evict the agent's cached prefix. Fix: skip title generation on the local engine, or use a second slot. Only if MiniCPM stays in scope.
7. **Checks default to empty.** Addressed properly in Phase 7; no change here.

Exit criteria (G2): each fix has a test; ablations show no regression on the dev set; the baseline is re-run with fixes as the new "harness v1.1" reference.

## 7. Phase 3: harness kernel (profiles, flags, telemetry)

Goal: a structure that lets every later feature be switched per model, measured, and explained. Can run in parallel with Phase 2.

### 7.1 Feature flags

1. Every harness feature gets a named flag in `HarnessConfig` (project `harness.json`) and an environment override for the eval (`MIDNIGHT_SERVER_HARNESS_FEATURES=+ctxpack,-contract`), so the eval can build variants without code changes.
2. Unknown flag names are rejected (same rule as unknown config keys today).

### 7.2 Model profiles

1. A profile describes how the harness treats a model: capability class (`fast`, `frontier`, `local`), context window budget, which features are on, prompt variant, tool set, tool-description variant, reasoning level policy, output caps, escalation target.
2. Profiles are matched by provider and model ID pattern, with a default per capability class. Stored as data files in the package (resolved through `src/config.ts` helpers, not `__dirname`), overridable in user settings.
3. The existing local profile (`local-profile.ts`) becomes the `local` class profile.
4. `/harness` shows the active profile and why it matched.

### 7.3 Telemetry

1. A local, append-only event log per session (under the session directory or `MIDNIGHT_SERVER_HOME`): feature decisions (masked N results, repaired a path, rejected an edit, escalated), per-turn tokens and categories, check outcomes.
2. The eval runner reads these events, so harness decisions show up in eval reports.
3. No network upload. Size-capped.

### 7.4 Harness module layout

Split `harness/extension.ts` (445 lines, growing) into modules per concern with one registration file: `profiles.ts`, `telemetry.ts`, `context/`, `gate/` (validation at action time), `verify/` (ladder, stop rule, rollback), `escalate/`, `semantic/` (LSP and syntax trees). Keep the public behavior of existing features unchanged during the split, with existing tests passing.

Exit criteria: flags and profiles work in the eval; telemetry events appear in eval reports; `npm run check` and existing harness tests pass.

## 8. Phase 4: context engineering

Goal: fewer exploration turns and smaller per-turn context. Can run in parallel with Phase 5.

### 8.1 Measure the fixed cost

1. Count tokens of the system prompt, each tool schema, context files and skills listing, per model profile. Add this to `/harness` and eval reports.
2. Target: a fast-model system prompt plus tool schemas under a fixed budget (set after measuring; the fast profile should be well below the frontier default).

### 8.2 Prompt and tool-schema diet

1. A terse system prompt variant per capability class. Keep safety and project-trust rules; remove prose a fast model does not use.
2. Terse tool descriptions per class; shorter parameter descriptions; drop rarely used optional parameters from the fast profile schema.
3. Tool set per class: fast profile gets core tools plus the new lookup tools (Phase 6), not MCP gateways, unless the project enables them.
4. Measure each change separately (solve rate can drop when guidance is removed).

### 8.3 Context pack (turn 0)

Problem: a fast model spends its first several turns on `ls`, `find`, `grep` and reading whole files. Example: "fix parsePort" costs 3-6 exploration turns before the first edit, each resending the whole context.

Solution: before the first model turn, the harness computes a compact pack and puts it in the first user message (or a system prompt section):

1. **Repo map**: files with their top-level symbols (functions, classes, exports), ranked and cut to a token budget. Source: syntax trees (Phase 6.2); until then, a regex/ctags-style fallback.
2. **Relevant files**: rank files by the prompt using BM25 over path, symbol names and content, plus boosts for files named in the prompt, recently changed files (`git status`, `git log -n 20 --name-only`), and test files paired with source files. Include the top few files in full or as symbol outlines, within budget.
3. **Current failures**: if the prompt mentions tests, lint or build failing, and checks are known (Phase 7.1), run the relevant check once and include its bounded output.
4. **Environment facts**: OS, shell, package manager, test command, language versions. Prevents environment mistakes.
5. Budget: a fixed token cap per profile; every part is optional and measured.
6. Cache stability: the pack sits in the first user message, after the stable system prompt, so it does not break the prompt cache across sessions of the same project; ordering is deterministic.

Ablate: pack on/off, and each part on/off, on navigation-heavy tasks and on the whole dev set.

### 8.4 State instead of transcript (long sessions)

1. A compact working state maintained by the harness from events, not by the model: goal (the user prompt), files touched, last check results, errors seen, current diff summary.
2. Used as the compaction output for fast and local profiles instead of an LLM summary (cheaper, deterministic), combined with masking as in the JetBrains hybrid result.
3. Ablate against LLM summary compaction on long tasks.

### 8.5 Masking v2

Token-based, window-relative (Phase 2), cache-aware (Phase 2), and stub text that names what the result contained (for example "read src/app.ts lines 1-400; symbols: parsePort, validate") so the model knows whether to re-read.

Exit criteria (part of G3): turns before first edit drop measurably on navigation tasks; tokens per solved task drop on the dev set; solve rate does not drop.

## 9. Phase 5: validation at the moment of action

Goal: catch mistakes when they happen, in the same turn, instead of letting them compound. Can run in parallel with Phase 4.

1. **Parse check on edit.** After every `edit`/`write` of a source file, parse the new content (syntax trees, Phase 6.2; until then, the language's fastest syntax check where one exists: `node --check` for JS, `python -m py_compile`). If the edit breaks parsing where the file parsed before, reject it: restore the file, return the error with line and a short excerpt. The model's next action sees the reason, instead of discovering a broken file turns later.
2. **Diagnostics on edit.** When an LSP server or fast checker is available (Phase 6), return new errors in the edited file with the edit result: "edit applied; 1 new type error: line 12 ...". Only new diagnostics, capped.
3. **Tolerant edit matching.** When `oldText` is not found: try whitespace-normalized and indentation-normalized matches; if exactly one match exists, apply it and say so; if several, return the candidate line ranges. Never guess between several.
4. **Interface repair catalog v2.** Build from the Phase 1 dumb-error counts. Candidates: wrong path separators, wrong case on case-insensitive file systems, `cat`/`ls -la`/`head` in PowerShell mapped to equivalents or rejected with the PowerShell form, `&&` in Windows PowerShell 5.1, `cd dir && cmd` patterns, relative paths from the wrong directory, reading a directory with `read`. Each repair reported to the model, as today.
5. **Batch read tool.** One call reads several files or ranges, to cut turns (fast models often read files one per turn). Also allow `read` by symbol name once Phase 6 exists.
6. **Better tool error messages.** Every error says what to do next in one sentence (for example "path not found; did you mean src/port.js?").
7. **Loop detection.** Same tool call with the same arguments twice in a row, or the same failing command three times: tell the model and, from Phase 8, count it as an escalation signal.

Exit criteria (part of G3): dumb-error count and recover turns drop on the dev set; solve rate does not drop.

G3 decision (after Phases 4 and 5): continue with semantic tools and the ladder only if tokens per solved task or solve rate moved in the right direction. If neither moved, return to the taxonomy before building more.

## 10. Phase 6: semantic tools (LSP and syntax trees)

Goal: exact facts about code in few tokens. Can run in parallel with Phase 7.

### 10.1 LSP client

1. Discover language servers already available to the project, in this order: project-local (`node_modules/.bin/typescript-language-server`, `tsserver` from the project's `typescript`), then PATH (`pyright-langserver`, `rust-analyzer`, `gopls`). Do not download or bundle servers in the first version.
2. Trust: starting a project-local server runs project code, so it requires project trust, like `harness.json` checks.
3. Lifecycle: start lazily on first use, one server per language per session, restart on crash, stop on idle and on session end. Kill the process tree on exit (reuse the process utilities; on Windows ensure `.cmd` shims resolve).
4. Protocol: JSON-RPC over stdio. Adding `vscode-jsonrpc`/`vscode-languageserver-protocol` or writing a minimal client are both options; decide after reviewing dependency size, license and shrinkwrap impact. A minimal client covering the requests below is small.
5. Requests used: definition, references, document symbols, workspace symbols, hover (type signature only), diagnostics (pull or publish), rename (as a proposal the harness applies through the normal edit path).
6. Timeouts and fallbacks: every request bounded; on failure, fall back to syntax-tree or grep results and say so.

### 10.2 Syntax trees

1. `web-tree-sitter` (WASM) with grammars for TS/JS, Python, Go, Rust. Check Bun compile compatibility and asset resolution through `src/config.ts`; WASM files ship as assets.
2. Used for: repo map (Phase 4.3), parse check on edit (Phase 5.1), symbol outlines, `read` by symbol.
3. Dependency review per `AGENTS.md`: exact version pin, lockfile and shrinkwrap regeneration, no lifecycle scripts.

### 10.3 Tools exposed to the model

Keep the set small (tool count costs tokens and accuracy):

1. `lookup`: one tool with `op` = `definition | references | symbols | outline`, taking a symbol name or file and line. Returns locations with one-line context, capped.
2. `diagnostics`: current errors for given files (or the edited files).
3. `rename`: proposal applied through the edit path, so protection and validation still apply.

Ablate each tool; drop any that the fast model does not use well.

Exit criteria: lookup tools answer correctly on a fixture repo for each supported language (unit and suite tests with fixtures); eval shows fewer explore turns on navigation tasks.

## 11. Phase 7: verification ladder, auto-checks, stop rule, rollback

Goal: the harness, not the model, decides what "done" means and proves it cheaply. This is the core of "feels smarter".

### 11.1 Check auto-detection

1. Detect project types and their commands without `harness.json`: `package.json` scripts (`test`, `lint`, `typecheck`, `check`), `tsconfig.json` (`tsc --noEmit` or the project's own type-check script), `pyproject.toml`/`pytest.ini`/`setup.cfg` (pytest), `ruff`/`mypy` configs, `Cargo.toml` (`cargo check`, `cargo test`), `go.mod` (`go vet`, `go test`), `Makefile` targets named `test`/`check`.
2. Present detected checks once per project for trust ("run these after changes?"). Store the answer in project settings. Non-interactive runs require `--approve`, as today.
3. `harness.json` still overrides detection.

### 11.2 Ladder

Run cheapest first, stop at the first failure, return that failure only:

1. Parse (already done at edit time).
2. Type check and lint on changed files (incremental where the tool supports it).
3. Tests related to changed files: by naming convention (`x.ts` ↔ `x.test.ts`), by import graph (syntax trees), or by the test runner's own related-test mode (e.g. `vitest related`, `jest --findRelatedTests`).
4. Full test suite (only if configured or cheap enough, by measured duration).
5. Generated property and differential tests (11.5).
6. Formal verification, only where the repo already uses a verifier (Phase 11).

### 11.3 Running checks during the run, not only at the end

The current harness checks when the model says it is done. Add: after a batch of edits (when the model's turn ends with no further edit in the same turn), run levels 1-3 and attach the result to the next turn. Measure against settle-only checking: earlier feedback may save turns or may add noise.

### 11.4 Stop rule

When the diff is non-empty, the ladder passes up to the configured level, and the task has no open clarifying question, the harness ends the run with a short harness-written verification summary. The model is not asked to verify again. Configurable per profile; measured against letting the model decide.

### 11.5 Property and differential tests (level 5)

1. Differential: for refactors and bug fixes, run the old version (from git) and new version of changed functions on generated inputs; report input where outputs differ. Needs: a runner per language (JS/TS first), input generation from type signatures (fast-check arbitraries for TS types), sandboxed execution with timeouts.
2. Property: the model states one or two properties of the function (cheap, a few tokens), the harness runs fast-check or Hypothesis and returns a counterexample.
3. Only for pure or near-pure functions detected by simple rules (no I/O imports in the function body); otherwise skip.
4. Security: generated tests run project code; require trust; run with the same timeout and output caps as checks.

### 11.6 Checkpoints and rollback

1. Before each repair round, snapshot the working tree to a private ref (`git write-tree` plus a ref under `refs/midnight/checkpoints/`) without touching the user's index, branches or stash.
2. On a repeated failure of the same check, restore the last passing checkpoint and tell the model what was tried and why it failed, instead of letting fixes pile up.
3. Clean up private refs at session end. Non-git workspaces: copy changed files to a temporary directory instead.

### 11.7 Contract, revised

If Phase 2 keeps the contract at all, the fast profile uses a harness-written contract: acceptance criteria derived from the prompt, detected checks and failing tests, shown to the model read-only. The model no longer spends tokens writing or marking it.

Exit criteria (G4): false-done rate at or below the target; solve rate up on the dev set; tokens per solved task not up. Confirm on the holdout set once.

## 12. Phase 8: escalation cascade

Goal: pay strong-model prices only for the hard steps.

1. **Signals**: the same check failing after a repair round; loop detection (Phase 5.7); rollback happened; turn budget exceeded for the task size; the model says it is stuck. Later, a learned predictor (8.6).
2. **Target**: the escalation model from the profile (a strong model the user has configured). No escalation if none is configured; then signals only end the run earlier with an honest report.
3. **Handoff**: the strong model gets the working state (Phase 4.4), the current diff, the failing check output and the context pack, not the whole transcript. It returns either an edit set or a short plan.
4. **Return**: after the strong model's step, control returns to the fast model for the remaining routine work (apply, run checks, small fixes). Measure against letting the strong model finish.
5. **Budget caps**: per-session limit on escalated tokens and dollars; shown in `/harness` and the footer.
6. **Learned router (later)**: train a small classifier (logistic regression or gradient boosting, in-process, no new heavy dependency) on eval telemetry features (task size, failure counts, loop flags, turn number) to predict "fast model will fail". Only after enough telemetry exists.
7. **Provider rules**: escalation respects `--local`/offline restrictions and `restrictRequestProviders`; it never sends data to a provider the session is not allowed to use.

Exit criteria (G5): on the hard set, the cascade moves solve rate toward the strong model while total cost per solved task stays below the strong model's.

## 13. Phase 9: per-model optimization

Goal: tune the wording the harness controls (system prompt variant, tool descriptions, error messages, repair notes) per model, automatically, without overfitting.

1. Parameterize the text pieces as templates in the profile data files.
2. Search loop (GEPA/DSPy-style reflective search): run the dev set, have a strong model read failed traces and propose text changes, keep changes that improve dev results, repeat within a budget.
3. Guardrails: only the holdout set decides whether a tuned profile ships; changes must be general (no task names, no file names from the eval); review every accepted change by hand.
4. Re-run when a provider updates a model; profiles record the model version they were tuned on.

Exit criteria: holdout improvement for at least one fast model; no regression for the strong reference.

## 14. Phase 10: local model repositioning (depends on the G0 decision)

Options for G0:

- **A. Offline mode only.** Keep `--local` as a separate, private, no-network mode. Remove MiniCPM from the default cloud path: no `delegate_local`, no drift watch, no local title generation in cloud sessions, unless measured to help. Apply Phase 2 fixes 1, 5, 6.
- **B. Keep hybrid features and measure them.** Add `delegate_local` and drift watch as eval variants; keep only if they improve a fast model's solve rate or cost. The earlier audit suggests they will not (latency 12-50 s per helper call on CPU, drift findings hidden by design).
- **C. Replace with small non-generative ML.** Use a small local embedding model and reranker for the context pack (Phase 4.3) if BM25 ranking proves insufficient. Adds an ONNX or similar runtime dependency; needs a size and licence review.

Recommended: A, plus C only if Phase 4 measurements show retrieval quality is the bottleneck.

If `--local` stays, its own improvement track (from the first research report) is: compaction and masking fixes, grammar-constrained tool calls, n-gram speculative decoding, prompt cache saved to disk, KV cache quantization for 16K context, and a trajectory-based LoRA. That track is separate from this plan's main goal.

Nothing in `src/midnight/` is removed without explicit user approval.

## 15. Phase 11: research track (time-boxed, can run any time)

Each item gets a written one-page result: what was tried, numbers, recommendation.

1. **Formal verification**: for repos that already contain Dafny, Lean or Verus, add the verifier as ladder level 6 (auto-detected). Measure whether fast models can close verifier errors with harness-structured feedback. No new language adoption.
2. **Bend2**: watch. Its principle (a checker blocks model mistakes) is what Phases 5 and 7 implement for mainstream languages. Revisit if its proof automation or program synthesis becomes usable and a user base appears.
3. **World models / JEPA**: watch. Executing code on the user's machine is a cheap, exact world model for this product; learned surrogates matter when execution is expensive.
4. **Symbol-constrained generation**: for providers that support grammars or structured outputs, constrain identifiers in edits to known symbols. Likely only feasible for the local model.
5. **Parallel sampling with checks choosing**: for the edit step on hard tasks, sample N candidate edits from the fast model and keep the one that passes the ladder. Compare cost against escalation.

## 16. Phase 12: release, documentation, defaults

1. Defaults: features on by default only if they passed their gate. Fast-model profile features on by default for models matched to the `fast` class.
2. Documentation: rewrite `packages/coding-agent/docs/harness.md` for the new design; update `README.md`, `docs/IMPLEMENTATION_STATUS.md`, `evals/harness/RESULTS.md` with gate results.
3. Changelog entries under `## [Unreleased]` in `packages/coding-agent/CHANGELOG.md` (per `AGENTS.md` changelog rules, on main or the PR).
4. `/harness` shows: profile, features, checks (detected or configured), context pack size, masking savings, escalations and their cost, telemetry location.
5. Kill switches: `MIDNIGHT_SERVER_HARNESS=0` stays; per-feature flags documented.
6. Windows CI (`.github/workflows/midnight-windows.yml`) and release workflow run the new unit and suite tests; the eval smoke subset runs on demand (it costs tokens), not on every push.
7. G6: final holdout run for every roster model; results published in `RESULTS.md`.

## 17. Cross-cutting requirements

### 17.1 Security and trust

- Anything that runs project code (checks, LSP servers from `node_modules`, generated tests, differential runs) requires project trust.
- Protected files keep working for every new edit path (tolerant matching, rename, rollback).
- Escalation never crosses provider restrictions (`--local`, `--offline`, `restrictRequestProviders`).
- Telemetry stays local.
- Checkpoint refs never modify the user's branches, index or stash.

### 17.2 Performance budgets

- Harness overhead per turn (excluding checks): under 50 ms at the 95th percentile on the reference machine.
- Context pack computation: under 2 s for a 5,000-file repo, cached per commit.
- Check and LSP timeouts: bounded and configurable; output capped as today.

### 17.3 Windows

- PowerShell 5.1 and 7 differences (`&&`, redirects), `.cmd` shim resolution, path case, long paths, non-ASCII paths (a previous engine bug came from this), process-tree kill.
- Every new process type (LSP, generated tests) tested on Windows in CI.

### 17.4 Testing

- Unit tests for every module; suite tests with the faux provider for harness behavior across turns (see `test/suite/README.md`).
- Fixture repos per language for LSP and syntax trees.
- Eval results are evidence for gates; unit and suite tests are evidence for correctness. Neither replaces the other.

### 17.5 Dependencies

Candidate additions, each reviewed per `AGENTS.md` (exact pins, lockfile and shrinkwrap, no lifecycle scripts, Bun compile check):

- `web-tree-sitter` and grammar WASM files (Phase 6.2).
- An LSP JSON-RPC library, or none if a minimal client is written (Phase 6.1).
- `fast-check`, used only inside generated test runners in the user's project environment, not as a product dependency, if possible (Phase 7.5).

## 18. Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Eval too small or too easy | Changes look neutral or random | Phase 1 exit criteria on difficulty and detectable difference |
| Overfitting to the eval | Gains do not transfer to users | dev/holdout split; holdout only at gates; real-repo tasks |
| Harness overhead outweighs savings | More tokens, slower runs | Every feature ablated; per-feature flags; performance budgets |
| Provider model updates | Tuned profiles go stale | Profiles record model version; re-run eval on updates |
| LSP servers unavailable or slow on user machines | Lookup tools fail | Fallback to syntax trees and grep; lazy start; timeouts |
| Auto-detected checks are slow or flaky | Runs stall or loop | Measured durations; ladder stops early; timeouts; user can edit detected checks |
| Escalation cost surprises users | Loss of trust | Per-session caps; visible cost; off unless configured |
| Dependency or packaging problems (WASM in Bun binary) | Release blocked | Spike in Phase 6 before committing to tree-sitter; regex fallback |
| Removing features users rely on | Regressions | Ask before removal; flags first, removal later |

## 19. Decisions (fill in at G0 and each gate)

| Decision | Options | Chosen | Date |
| --- | --- | --- | --- |
| Target fast models and IDs | Luna, DeepSeek V4.1 Flash, others | | |
| Strong reference and escalation model | | | |
| Reasoning levels per model in eval | | | |
| Eval budget per full run | | | |
| MiniCPM role (Phase 10) | A / B / C | | |
| Telemetry export | none / opt-in | | |
| Numeric targets (Section 1.4) | set after G1 | | |
| Contract fate (Phase 2.4) | keep / harness-written / off for fast | | |
| LSP client approach | library / minimal client | | |
| Tree-sitter adoption | yes / fallback only | | |

## 20. Order of work in short

1. Decide roster, budgets, MiniCPM role (Phase 0).
2. Build the eval that can see differences; baseline; failure taxonomy (Phase 1, G1).
3. Fix known defects and build flags, profiles and telemetry (Phases 2 and 3, G2).
4. Remove exploration turns and catch mistakes at the moment of action (Phases 4 and 5, G3).
5. Semantic lookup tools; harness-owned verification, stop rule and rollback (Phases 6 and 7, G4).
6. Escalate only the hard steps (Phase 8, G5).
7. Tune wording per model on the dev set, confirm on the holdout (Phase 9).
8. Ship what passed, document, set defaults (Phase 12, G6).
