# Harness

The harness is a built-in extension that makes whatever model runs the session more accurate and cheaper to run. Its principle: a model spends tokens on every turn it takes, so the harness does in code what the model would otherwise do in turns. It explores the workspace before the first request, catches mistakes at the moment they happen, verifies the result with the project's own checks, and asks a stronger model for advice only when a fast one is stuck.

Everything works with any session model, and nothing the harness adds sends your code anywhere except the escalation advisor, which uses a model you configured. Features switch by model class:

| Class | Which models | Differences |
| --- | --- | --- |
| `fast` | List input price under $2 per million tokens, or unknown | Everything on, including escalation |
| `frontier` | Input price $2 per million tokens or more | No escalation |

`/harness` shows the class, the active features, the checks, and what the harness did in this session.

## Before the first request: the context pack

Problem: a fast model starts most tasks with `ls`, `find`, `grep` and `read`. Each of those turns resends the whole prompt.

The harness indexes the workspace (git's file list; paths, declarations and content) and ranks files for the request with identifier-aware BM25: `parsePortNumber` matches "parse", "port" and "number"; a file named in the request, or declaring a symbol the request names in code form (`parsePort`, `parse_port`, backticks), ranks first; tests are paired with their sources. The first request then carries, within a token budget (2,000 for fast models, 2,500 frontier, and never more than 10% of the context window):

- the environment: OS, shell tool (and that PowerShell is not bash), package manager, test command, the checks the harness will run;
- the git branch and changed files;
- the ranked files with their main declarations and line numbers;
- the full contents of the top files, or for a large file, the declarations the request is about;
- a map of other files.

Later prompts in the same session get only a new ranking. Indexing is incremental (unchanged files are reused); on a 2,000-file repository the first index takes about 2.5 s and a refresh under 0.1 s.

## At each action

- **Syntax gate.** After every `edit` or `write`, the file is parsed with the machine's own parser: the project's `typescript` for TS/JS (else `node --check`), Python's `ast`, `gofmt`, `rustfmt`, `JSON.parse`. If the edit made a valid file invalid, the harness restores the previous content and returns an error with the parser's message, in the same turn. A file that was already broken is never blocked.
- **Indentation repair.** When `oldText` matches the file in exactly one place once leading whitespace is ignored, the harness rewrites `oldText` to the file's real text and re-indents `newText` line by line to the file's style. Ambiguous or missing matches are left alone.
- **Closest-match hints.** When an edit's text is not found, the error includes the most similar block of the file with its line numbers, so the model can copy it instead of reading the file again.
- **Path hints.** A missing path gets "did you mean" suggestions from the workspace (same name elsewhere, near-miss names, other extensions).
- **Loop notices.** The same call with the same arguments since the last file change, or the same command failing twice in a row with the same error, gets a note saying so. A fix-and-retest cycle is not a loop: an edit, or a shell command that succeeds, resets the counters. Calling a tool again after masking or compaction removed its earlier result is not a loop either. Repeated shell commands are only noticed when they fail.
- **Language-server errors.** In trusted projects, if a language server is installed (project `node_modules/.bin` or PATH: `typescript-language-server`, `pyright-langserver`, `gopls`, `rust-analyzer`), errors the edit introduced are appended to the edit result. Errors that existed before the edit are not reported.
- **Interface repairs**, as before: foreign absolute paths such as `/workspace/math.js` are mapped into the workspace, POSIX null redirects are rewritten for PowerShell, and shell calls without a timeout get one.

## The `lookup` tool

`lookup` answers "where is X defined", "who uses X" and "what is in this file" by symbol name, without the model supplying line and column positions:

- `definition`: the declaration with its body (up to 40 lines), from the harness index, or from the language server's workspace symbols when the index has no match.
- `references`: every use, from the language server when one is available, else a word search.
- `outline`: a file's declarations, from the language server or the harness outline.

## Checks

Checks are the project's own commands. They come from `.midnight.server/harness.json` or, when that file lists none, are detected from the project (trusted projects only, since they run project code):

| Found | Level 1 (types, lint) | Level 2 (related tests) | Level 3 (all tests) |
| --- | --- | --- | --- |
| `package.json` | `typecheck`/`check-types`/`tsc` script, or `tsc --noEmit` with a `tsconfig.json`; a `lint` script that does not write files | `vitest run`, `jest` or `node --test` on the tests related to changed files | the `test` script |
| pytest configuration | `mypy` when configured | `pytest` on related tests | `pytest` |
| `go.mod` | `go vet ./...` | | `go test ./...` |
| `Cargo.toml` | `cargo check` | | `cargo test` |

Related tests are found by name (`port.js` and `port.test.js`, `test_port.py`, `port_test.go`) and by imports. Detected checks run with `CI=1`.

Checks run as a ladder: level by level, stopping at the first level that fails, so a type error is reported without waiting for the test suite.

A check's result is reused while nothing it could depend on has changed: no successful `edit` or `write`, no shell command (it may install a dependency or start a service), no rollback, and no new request since it ran with the same command. The common case is the settle ladder right after an in-run check: levels 1 and 2 already ran on the same files, so only level 3 runs. Timeouts are never reused. `features: { "checkCache": false }` turns it off; `/harness` shows how many results were reused.

- **During the run**: once the model stops editing (a turn with no edits after turns that edited files), levels 1 and 2 run, and the result goes into the next request: failures in full, or "checks pass; you do not need to rerun them". A turn that edits again does not trigger them, so a change spread over several turns (a signature, then its callers) is not flagged halfway. A check that took more than 90 s is skipped here, and so is a type check (`types`, `typecheck`, `tsc`, `mypy`, `pyright`, `cargo check`) when a language server already checked every changed file it covers.
- **Before the run settles**: the full ladder runs on everything changed. On failure the model gets the output and another turn, up to `maxRepairRounds` (default 2). Ending again without changes does not skip the check: the same files are checked again.

### Baseline for static checks

A project that already has type or lint errors would otherwise fail every settle, and each repair round is a full model turn spent on code the request never touched. With `checkBaseline` (on by default), the static checks (types and lint by name: `types`, `typecheck`, `tsc`, `mypy`, `pyright`, `cargo check`, `lint`, `vet`, `eslint`, `ruff`, `biome`, `clippy`, `flake8`, `pylint`; project-wide, no `{files}`) run in the background when a request starts, on the tree as the request found it. The first edit or shell command waits up to 15 s for them; a baseline that finishes after something changed is discarded. While the git tree is unchanged, the last baseline is reused.

A failing static check is then compared with its baseline (`src/harness/baseline.ts`). Error lines are compared with line numbers, counts and durations removed; an indented line counts under the unindented line above it (the file in ESLint output). A second copy of an existing error is new.

- Only errors the baseline had: the check is shown as `[known]`, does not stop the ladder (the tests still run) and does not start a repair round.
- New errors too: the feedback lists only the new error lines and says how many known ones were left out, instead of the raw log.
- A different exit code, a timeout or unrecognized output that differs from the baseline: the failure is treated as new.

Test checks never get a baseline: a failing test at the start is often what the request is about. `features: { "checkBaseline": false }` turns it off; `/harness` shows how many failures were held back.

### Rollback

Each time the checks pass, the harness snapshots the working tree to a private ref under `refs/midnight/checkpoints/` (a commit built from a temporary index; the user's index, branches, HEAD and stash are never touched). When the same checks fail twice in a row, the harness restores the files the agent edited to the last passing snapshot and shows the model the change it reverted, so the next attempt starts from working code with the failed idea in view. Only files the agent changed with `edit` or `write` in the current request are restored; everything else, such as the user's own edits, is left alone. A snapshot from an earlier request is never used: each request starts without one. Refs are deleted when the session ends. Workspaces that are not git repositories have no snapshots.

## Implementation drift

Implementation drift is a change that moves away from what was asked toward something simpler or more familiar, usually when the real thing gets hard, without saying so. Example: asked to make `parsePort` reject invalid ports, a model hits a failing test, comments out the assertion, and reports "Done. All tests pass." Every check is green and the request is not done. Deviating is sometimes right; deviating silently is the failure.

- **Drift guard (`driftGuard`).** When the checks pass (or there are none), the harness compares the finished change with the request: every file that differs from the start of the request, shell edits included (a git snapshot of the working tree taken when the request starts; outside git, files changed through `edit`/`write`). It reports concrete evidence, from deterministic detectors:
  - weakened tests: assertions removed or commented out, exact assertions replaced by weak ones (`assert.ok(x !== undefined)`, `toBeDefined()`), tests skipped or narrowed (`.skip`, `.only`, `@pytest.mark.skip`), test files deleted;
  - a test input hard-coded into source: new code compares against a literal from the tests that neither the request nor the file mentioned before;
  - stubs (`TODO`, `not implemented`, "simplified", "for now"), swallowed errors (empty `catch`, `except: pass`, `.catch(() => {})`), and top-level functions or classes removed when the request does not name them;
  - a blanket success claim ("all tests pass") that no check or test command made after the last change supports, and that the message does not qualify with what still fails.
  - side effects outside the code, from the request's shell commands: a process left running in the background (`Start-Process`, `Start-Job`, `nohup`, a trailing `&`), which often stands in for a missing service, and processes ended (`Stop-Process`, `taskkill`, `kill`). When a run settles with failing checks, the message names a background process the run started.

  If any of these appear, the model gets one turn per request to fix them or to say plainly in its final message what differs from the request and why. Files the request names that the change never touches are recorded, not acted on.
- **Blocker rule (`blockerExit`).** A sanctioned way to stop instead of drifting, in three parts:
  - one line in the system prompt: if the request cannot be done as asked (tests contradict it, something it needs is missing, it needs more than the model can do), do what is correct and say what blocks it, instead of substituting a simpler approach, stubbing, or changing tests (the same offer cut test-exploiting behavior from 54% to 9% for GPT-5 in ImpossibleBench);
  - failing-check feedback adds that the request wins over a test that contradicts it;
  - after one repair round, a model whose final message reports why the checks cannot pass, without claiming success, gets no further repair rounds; the failing checks are shown and the run settles.

  Without the last two, the repair loop itself caused drift: facing a protected test that contradicted the request, the model restored the old behavior or special-cased the test's input to get the check to pass (0/8 correct across the harness arms of `evals/drift` pilot 01). With them it did what was asked and reported the conflict (4/4 in pilot 02).

Both are on by default. `evals/drift/` has the drift benchmark, the detector checks and the results (`evals/drift/RESULTS.md`).

## Adaptive repair

When the same checks fail again, `adaptiveRepair` marks the previous approach as rejected, includes diagnostic lines that may have been buried in a long compiler or test log, and requires a materially different repair or an explicit blocker. With checkpoints enabled, the harness restores the last passing state before the next attempt. It is enabled by default and can be disabled for ablation with `-adaptiveRepair`.

## When the model is stuck: divergence

Problem: after a failed repair a model tends to retry the same idea, and repeated attempts on one task are strongly correlated (`docs/LUNA_DESIGN.md`), so a retry that resembles a rejected attempt fails the same way. Example: the checks reject `if (n < 0)`; the next attempt is `if (n <= 0)` in the same place.

Each time the settle checks fail, the harness records the request's whole change as a rejected attempt and fingerprints it (token trigrams of the added and removed lines, so re-indenting or moving the same change does not make it new). When the same checks fail again, or a new attempt is at least 80% the same change as a rejected one, the feedback (`divergence`):

- names the repeat with its measured similarity ("This attempt is 92% the same change as attempt 1, which the checks already rejected");
- lists the approaches the checks rejected in this request, with their files and first added lines;
- asks for three causes that differ in kind (input or data format, control flow or an edge case, environment or a dependency, a different reading of the request or the test), what in the output supports or rules out each, and the most likely one no rejected attempt tried.

At the same moments, and when the loop guard has noticed two repeats, `reasoningBoost` raises the thinking level of a reasoning model one step (from `off` or `minimal` straight to `low`), at most twice per request and never above `high`. The level returns to the user's setting when the run settles, unless the user changed it meanwhile. A request that is not stuck runs at the user's level: the extra thinking is spent only where the first idea failed.

## Verifier probe

Problem: the repair loop drives every run to green checks, so whatever remains wrong is exactly what the checks cannot see; in the drift pilots, 17 of 17 hidden failures passed the visible checks. Example: the model adds `if (n > 65535) return false;` and the tests pass, but no test calls it with 65535 or 65536, so `>=` would pass too.

With `mutationProbe` on, after the settle checks pass (and the drift guard has nothing to ask), the harness makes up to six small mutants of the lines the request changed: comparisons (`<` and `<=`), equality, `&&` and `||`, `+` and `-`, booleans, integer constants. Only operators with spaces on both sides are changed, strings and comments are skipped, and a mutant that does not parse is dropped. It reruns the related tests (ladder level 2, else level 3) on each mutant and reports the ones no test noticed, with the line and the change, asking the model to pin the behavior the request depends on with a focused test or to say that it is unverified. It runs once per request, within a time budget (60 s by default), and never on test files.

Mutants are written into the working tree one at a time and always restored. Before each write a journal entry outside the workspace records the original and the mutant; if the process dies mid-probe, the next session restores any file whose content is still exactly the mutant and leaves a file that changed since alone. The probe is off by default because it costs test runs; the policy loop below turns it on only if the evidence says it pays. The measured kill rate had AUC 0.71 for hidden failure on the pilots: it shows where tests are weak, it is not a failure detector.

## Escalation

When a fast model is stuck (the same checks failed twice, or it repeated itself three times), the harness asks a stronger model for one piece of advice and hands control back. The advisor gets the request, the current diff (new files included), the failing output and the model's last message, not the transcript. Default advisor: `anthropic/claude-opus-5-5`; it is used only if that model has credentials, and never when it is the session model. Limits: 2 calls per prompt, 6 per session. `/harness` shows the calls and their cost, and each call is written to the telemetry log with its model, tokens and cost. With escalation on, a result is a cascade result: to measure a fast model alone, turn it off (`-escalation`).

## The policy loop

The harness's feature switches (per model class) and thresholds (repair rounds, probe size and budget, repeat similarity, boost ceiling) are a policy that the harness improves from its own sessions, using the Lattice-1 kernel in `src/lattice/` ([docs/lattice](../../../docs/lattice/README.md)). Nothing needs a command:

1. The policy is a versioned record (`harness.policy`) in the Lattice store (`~/.midnight.server/lattice`, or `LATTICE_DATA`). The first version is the built-in defaults.
2. After 20 requests with checks under the active version, the kernel starts a trial of one candidate: one feature toggled for one model class, or one parameter moved one step, chosen by an upper-confidence bandit over which kinds of change paid before. A candidate an earlier trial rejected is not tried again.
3. During a trial each new session runs the active version or the candidate with equal probability. Every settled request is recorded: whether it ended resolved (checks pass, or the model reported a blocker) without actionable drift, and its tokens.
4. When both arms have 30 requests with checks, the gate decides. It is a conjunction: the candidate's resolved rate must be higher at a one-sided bootstrap lower bound (alpha spent across trials), or no worse within 3 points and at least 10% cheaper in tokens; drift may not rise and tokens may not grow by more than half. Evidence is used once. A trial that has not passed after 300 requests per arm is rejected.
5. A passing candidate is promoted with a compare-and-swap into a canary that serves every session. If its resolved rate falls more than 10 points below its parent's over 15 requests, it is rolled back; after 40 requests that are not worse it becomes the champion. Every step is an audit record in the store.

What the loop may not change: `blockerExit`, `driftGuard` and `parseGate` stay on, `masking` follows `harness.json`, and `escalation` (it spends money on another model) is the user's decision. The user's own settings always win: layering is class defaults, then the policy, then `harness.json`, then `MIDNIGHT_SERVER_HARNESS_FEATURES`. A policy applies from the next session; `/harness` shows the active version, the running trial with its evidence so far, and which arm the session runs.

Limits: live sessions have no hidden grader, so "resolved" is a proxy for success, which is why the gate also refuses more drift and the guarding features are out of reach. With 30 requests per arm the loop detects large effects only; smaller ones need the eval (`scripts/harness-eval.mjs`, where learning is off and each arm can pin a policy file).

## Protected files

`edit` and `write` calls on protected paths are blocked with an explanation. `.midnight.server/harness.json` is always protected. List test files or specs you own in `protect`. Shell commands are not inspected.

## Observation masking

Old, large tool results are replaced with a one-line stub (tool, arguments, size and line count). Thresholds scale with the model's context window: a batch is elided once 15% of the window is eligible, and the newest results are kept while they fit in a quarter of it (at least one). With a large window the configured byte values are the limits. Elision is recorded as `context_edit` entries, so it follows `/tree`.

## Configuration

`.midnight.server/harness.json` (requires project trust):

```json
{
	"checks": [
		{ "name": "types", "command": ["npx", "tsgo", "--noEmit"], "when": ["**/*.ts"], "level": 1 },
		{ "name": "unit", "command": ["npm", "test", "--", "--run"], "level": 3 }
	],
	"protect": ["test/**", "SPEC.md"],
	"maxRepairRounds": 2,
	"autoChecks": true,
	"features": { "contextPack": true, "lookup": false },
	"escalation": { "model": "anthropic/claude-opus-5-5", "maxCallsPerPrompt": 2, "maxCallsPerSession": 6 },
	"masking": { "enabled": true, "keepRecentResults": 6, "minResultBytes": 2000, "batchBytes": 48000 },
	"mutation": { "maxMutants": 6, "budgetSeconds": 60 },
	"shellTimeoutSeconds": 300
}
```

- `command` is an argument list, run without a shell. `{files}` expands to the changed files that matched `when`.
- `level` (1-3) places a check on the ladder; configured checks without one are level 1.
- Unknown keys and unknown feature names are rejected, so a typo does not silently disable anything.

Features: `contextPack`, `parseGate`, `editRepair`, `pathHints`, `loopGuard`, `inRunChecks`, `checkCache`, `checkBaseline`, `checkpoints`, `lookup`, `diagnostics`, `adaptiveRepair`, `escalation`, `masking`, `driftGuard`, `blockerExit`, `divergence`, `reasoningBoost`, `mutationProbe`.

Environment:

- `MIDNIGHT_SERVER_HARNESS=0` turns the harness off.
- `MIDNIGHT_SERVER_HARNESS_FEATURES=-contextPack,-escalation` switches features for one run (the eval uses this for ablations).
- `MIDNIGHT_SERVER_HARNESS_LEARN=0` turns the policy loop off: sessions run the built-in defaults and nothing is recorded.
- `MIDNIGHT_SERVER_HARNESS_POLICY=<file>` pins a policy (`{ "features": { "fast": { ... } }, "params": { ... } }`) and turns the loop off; the eval uses it for policy arms (`"policy"` on a manifest variant).
- `MIDNIGHT_SERVER_HARNESS_TELEMETRY=<file>` appends one JSON line per harness decision (pack built, edit rejected, check run, rollback, escalation). Nothing is sent anywhere.

## Measuring it

`scripts/harness-eval.mjs` runs tasks with the harness off (`bare`), on (`harness`), and in ablated variants, and grades each run with hidden tests copied in after the agent exits. There are 27 tasks in `evals/harness/tasks/` across ten categories (sanity, implied requirements, underspecified standards, hidden bugs, test traps, multi-file changes, navigation in a larger codebase, refactors, features, environment), in JavaScript, Python and Go, split into `dev` (tune on these) and `holdout` (judge on these). `node scripts/harness-eval-validate.mjs` checks that every task's starting state fails its grader and its reference solution passes.

```bash
node scripts/harness-eval-validate.mjs
node scripts/harness-eval.mjs --split dev --repeat 5 --jobs 4 -- --model <provider>/<fast-model>
node scripts/harness-eval.mjs --variants bare,harness,no-pack=-contextPack,no-gate=-parseGate -- --model <provider>/<model>
node scripts/harness-eval.mjs --checks detect -- --model <provider>/<model>
node scripts/harness-eval.mjs --report evals/harness/results/<file>.jsonl
```

The report gives, per variant: pass rate, tokens per run and per solved task, cost per solved task, turns, turns before the first edit, false "done" claims (the run ended normally and the hidden tests fail), avoidable tool errors by class, turns by category (explore, edit, verify, recover, answer), pass rate by task category, and the harness's own events. Against the first variant it gives the pass-rate difference with a 95% bootstrap interval over tasks and an exact McNemar test. Runs with a cloud model cost real tokens; `--max-cost` caps each run.

Outcomes are kept apart: `artifactPassed` (the hidden grader on the final files, run even after a timeout), `unchangedOk`, `completed`, `timedOut`, `overBudget`, and `success` (all of them; `passed` is `success`). For drift, each run also records requirement-level results (graders print `REQ <id> PASS|FAIL`), whether the visible checks pass at the end (a visible pass with a hidden failure is the proxy gap), changed test files, claimed success, disclosed limitations, silent drift (claimed success, hidden failure, nothing disclosed), and drift signals computed from the final change for every run, harness on or off. The final change is saved beside the events for re-scoring (`node evals/drift/rescore.mjs <results.jsonl>`).

For a designed experiment, `--manifest <file>` (format in `scripts/harness-eval-design.mjs`) fixes every arm's complete feature assignment, repeats and a seed that shuffles run order in each repeat block; the harness logs the features it actually resolved, and `scripts/harness-eval-export.mjs` refuses runs whose resolved treatment differs from the assignment when it exports to the sensitivity lab's schema (`evals/sensitivity-lab/harness_lab.py analyze`: factorial main effects, interactions and cluster-bootstrap intervals).

## Limits

- The harness has not yet been measured against cloud models with the new task set; `evals/harness/RESULTS.md` records what has been measured.
- Checks are only as good as the project's tests. A passing ladder means the commands exit 0.
- The syntax gate needs the language's parser on the machine; without one the file is not checked.
- Escalation sends the request, the diff and the failing output to the advisor model's provider.
