# Harness

The harness is a built-in extension that makes whatever model runs the session more accurate and cheaper to run. Its principle: a model spends tokens on every turn it takes, so the harness does in code what the model would otherwise do in turns. It explores the workspace before the first request, catches mistakes at the moment they happen, verifies the result with the project's own checks, and asks a stronger model for advice only when a fast one is stuck.

Everything works with any session model. Features switch by model class:

| Class | Which models | Differences |
| --- | --- | --- |
| `fast` | List input price under $2 per million tokens, or unknown | Everything on, including escalation |
| `frontier` | Input price $2 per million tokens or more | No escalation |
| `local` | The embedded MiniCPM model | Local profile on; no `lookup` tool (tool schemas cost prompt time on a CPU) |

`/harness` shows the class, the active features, the checks, and what the harness did in this session.

## Before the first request: the context pack

Problem: a fast model starts most tasks with `ls`, `find`, `grep` and `read`. Each of those turns resends the whole prompt.

The harness indexes the workspace (git's file list; paths, declarations and content) and ranks files for the request with identifier-aware BM25: `parsePortNumber` matches "parse", "port" and "number"; a file named in the request, or declaring a symbol the request names in code form (`parsePort`, `parse_port`, backticks), ranks first; tests are paired with their sources. The first request then carries, within a token budget (2,000 for fast models, 2,500 frontier, 600 local, and never more than 10% of the context window):

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
- **Loop notices.** The same call with the same arguments since the last file change, or the same failing command twice, gets a note saying so.
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

- **During the run**: after a turn that edited files, levels 1 and 2 run (a check that took more than 90 s is skipped here), and the result goes into the next request: failures in full, or "checks pass; you do not need to rerun them".
- **Before the run settles**: the full ladder runs on everything changed. On failure the model gets the output and another turn, up to `maxRepairRounds` (default 2). Ending again without changes does not skip the check: the same files are checked again.

### Rollback

Each time the checks pass, the harness snapshots the working tree to a private ref under `refs/midnight/checkpoints/` (a commit built from a temporary index; the user's index, branches, HEAD and stash are never touched). When the same checks fail twice in a row, the harness restores the last passing snapshot and shows the model the change it reverted, so the next attempt starts from working code with the failed idea in view. Refs are deleted when the session ends. Workspaces that are not git repositories have no snapshots.

## Escalation

When a fast model is stuck (the same checks failed twice, or it repeated itself three times), the harness asks a stronger model for one piece of advice and hands control back. The advisor gets the request, the current diff (new files included), the failing output and the model's last message, not the transcript. Default advisor: `anthropic/claude-opus-5-5`; it is used only if that model has credentials, and never when it is the session model. Limits: 2 calls per prompt, 6 per session. `/harness` shows the calls and their cost.

## Protected files

`edit` and `write` calls on protected paths are blocked with an explanation. `.midnight.server/harness.json` is always protected. List test files or specs you own in `protect`. Shell commands are not inspected.

## Observation masking

Old, large tool results are replaced with a one-line stub (tool, arguments, size and line count). Thresholds scale with the model's context window: a batch is elided once 15% of the window is eligible, and the newest results are kept while they fit in a quarter of it (at least one). With a large window the configured byte values are the limits. Elision is recorded as `context_edit` entries, so it follows `/tree`.

## Task contract (off by default)

The `task` tool records an objective, constraints and checkable acceptance criteria, and reminds the model of open criteria before it finishes. It is off by default: on GPT-6 Luna it added 73% tokens with no measured gain. Turn it on with `"contract": true` or `features: { "contract": true }`.

## Local-model profile

When the session model is the embedded MiniCPM model: only core tools stay active, tool output is capped at 6 KB, large project context files are listed instead of inlined, and requests without a temperature use greedy decoding.

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
	"shellTimeoutSeconds": 300
}
```

- `command` is an argument list, run without a shell. `{files}` expands to the changed files that matched `when`.
- `level` (1-3) places a check on the ladder; configured checks without one are level 1.
- Unknown keys and unknown feature names are rejected, so a typo does not silently disable anything.

Features: `contextPack`, `parseGate`, `editRepair`, `pathHints`, `loopGuard`, `inRunChecks`, `checkpoints`, `lookup`, `diagnostics`, `escalation`, `masking`, `contract`, `localProfile`.

Environment:

- `MIDNIGHT_SERVER_HARNESS=0` turns the harness off.
- `MIDNIGHT_SERVER_HARNESS_FEATURES=-contextPack,+contract` switches features for one run (the eval uses this for ablations).
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

## Limits

- The harness has not yet been measured against cloud models with the new task set; `evals/harness/RESULTS.md` records what has been measured.
- Checks are only as good as the project's tests. A passing ladder means the commands exit 0.
- The syntax gate needs the language's parser on the machine; without one the file is not checked.
- Escalation sends the request, the diff and the failing output to the advisor model's provider.
