# Harness

The harness is a built-in extension that sits around Pi's tool loop. It fixes tool calls that would otherwise fail and verifies the result once with the project's own checks when the model finishes. The baseline it has to beat is plain Pi (`MIDNIGHT_SERVER_HARNESS=0`), and `docs/WORKFLOW_PLAN.md` explains why the defaults are small.

Rules it follows:

- **Nothing slow while the model works.** During a run the harness only rewrites a tool call or adds a line to a result the model is already waiting for. Processes (checks, language servers) run when the model finishes, or only when a feature that needs them is switched on.
- **The history is append-only.** Nothing rewrites earlier messages, so the provider's prompt cache keeps working. When the window fills, Pi's compaction handles it.
- **The model hears from it once.** There are no messages mid-run. When the model finishes, the harness sends at most one repair round for failing checks and at most one drift note.
- **Every session behaves the same.** Features come from fixed defaults, `harness.json` and the environment. There are no live experiments.

`/harness` shows the active features, the checks, what the harness did in the session and how much time it spent in each hook.

## Session start

The harness detects the project (languages, package manager, test command, checks) and adds these facts to the system prompt as an `environment` section: the OS, the shell tool (and that PowerShell is not bash), the test command and the checks the harness will run. The facts are stable for the session, so they stay in the cached prompt prefix.

## At each tool call

- **Syntax gate (`parseGate`).** After every `edit` or `write`, the file is parsed with the machine's own parser: the project's `typescript` for TS/JS (else `node --check`), Python's `ast`, `gofmt`, `rustfmt` or `JSON.parse`. If the edit made a valid file invalid, the harness restores the previous content and returns an error with the parser's message in the same turn. A file that was already broken is never blocked.
- **Indentation repair (`editRepair`).** When `oldText` matches the file in exactly one place once leading whitespace is ignored, the harness rewrites `oldText` to the file's real text and re-indents `newText` to the file's style.
- **Closest-match hints (`editRepair`).** When an edit's text is not found, the error includes the most similar block of the file with its line numbers.
- **Path hints (`pathHints`).** A missing path gets "did you mean" suggestions from the workspace.
- **Loop notices (`loopGuard`).** Two cases get a note: the same call with the same arguments since the last file change, and the same command failing twice in a row with the same error. An edit, or a shell command that succeeds, resets the counters.
- **Interface repairs** (always on): foreign absolute paths such as `/workspace/math.js` are mapped into the workspace, POSIX null redirects are rewritten for PowerShell, and shell calls without a timeout get one (`shellTimeoutSeconds`, default 300).
- **Protected files** (always on): `edit` and `write` calls on protected paths are blocked with an explanation. `.midnight.server/harness.json` is always protected; list tests or specs you own in `protect`. Shell commands are not inspected.

## When the model finishes: one verification pass

Checks are the project's own commands. They come from `.midnight.server/harness.json` or, when that file lists none, are detected from the project. Detection only happens in trusted projects, since checks run project code:

| Found | Level 1 (types, lint) | Level 2 (related tests) | Level 3 (all tests) |
| --- | --- | --- | --- |
| `package.json` | `typecheck`/`check-types`/`tsc` script, or `tsc --noEmit` with a `tsconfig.json`; a `lint` script that does not write files | `vitest run`, `jest` or `node --test` on the tests related to changed files | the `test` script |
| pytest configuration | `mypy` when configured | `pytest` on related tests | `pytest` |
| `go.mod` | `go vet ./...` | | `go test ./...` |
| `Cargo.toml` | `cargo check` | | `cargo test` |

When the model finishes a run that changed files:

1. The checks for the changed files run level by level and stop at the first level that fails. Detected level-3 checks (the whole test suite) are left to the model, because on a real project they are the slowest thing the harness could run. A level-3 check you configure does run.
2. A check the model already ran successfully, with the same command and nothing changed since, is not run again. `npm test` and `npm run test` count as the same command.
3. If the checks pass, or there are none, the drift guard runs (below).
4. If a check fails, the model gets the smallest useful output (the failing lines, byte-capped, with diagnostic lines from the middle of long logs) and one repair round (`maxRepairRounds`, default 1). If it still fails after that, or the model reports why it cannot pass, the run ends with a message naming the failing checks.

### Failures the project already had (`checkBaseline`)

A project with existing type or lint errors would otherwise fail every run, and each repair round is a model turn spent on code the request never touched. Just before the first edit, write or shell command of a request, the harness records the working tree as a git tree object, which takes milliseconds. A request that only reads or answers runs no git at all. Only if a project-wide static check fails (types or lint by name, no `{files}`) does the harness write that tree to a temporary directory and run the same check there. Installed dependencies and build output are linked in from the real checkout. It then compares the two results (`src/harness/baseline.ts`):

- The check fails only with errors it already had before the request: it is shown as `[known]`, does not stop the ladder, and does not start a repair round.
- New errors too: the feedback lists only the new error lines.
- A different exit code, a timeout or unrecognized output: treated as new.

Results are cached per tree, so an unchanged tree never runs the baseline twice. Tests never get a baseline, because a failing test is often what the request is about. Outside git there is no baseline.

## Implementation drift

Implementation drift is a change that moves away from the request toward something simpler, without saying so. Example: asked to make `parsePort` reject invalid ports, a model comments out a failing assertion and reports "Done. All tests pass."

- **Drift guard (`driftGuard`).** Once the checks pass (or there are none), the harness compares every file that differs from the start of the request (shell edits included) with the request. It skips runs that neither edited files nor ran a shell command, and it reads only the workspace's file list (`git ls-files`) and its test files, never a full index. It looks for:
  - weakened tests;
  - test inputs hard-coded into source;
  - stubs and swallowed errors;
  - removed declarations the request does not name;
  - success claims that no check or test run after the last change supports;
  - processes left running in the background or ended.

  If any appear, the model gets one turn to fix them or to say plainly what differs from the request.
- **Blocker rule (`blockerExit`).** It has three parts:
  - One line in the system prompt says that if the request cannot be done as asked, the model should do what is correct and say what blocks it.
  - Failing-check feedback adds that the request wins over a test that contradicts it.
  - After a repair round, a model that reports why the checks cannot pass, without claiming success, is not pushed again.

  In `evals/drift` pilot 01 the repair loop without this rule produced test-specific special cases (0/8 correct on the contradicting-test task). With the rule on, the model did what was asked and reported the conflict (4/4 in pilot 02).

## Opt-in features

These features are off by default. None of them has shown a gain over plain Pi that pays for its cost; the eval below is how one earns its way back.

- **`contextPack`**: a repo map, ranked files and their contents in the first request of a session. Later requests get only a new ranking.
- **`lookup`**: a tool that finds a symbol's definition, its references, or a file's outline, through a language server when one is installed. It adds a tool to every request.
- **`diagnostics`**: after each edit, new language-server errors are appended to the edit result. Each edit waits for the server, up to 8 s.
- **`escalation`**: when the settle checks fail, the harness asks a stronger model (`escalation.model`, default `anthropic/claude-opus-5-5`, used only with credentials and never when it is the session model) for one piece of advice. The advice is sent with the repair feedback. The advisor gets the request, the diff, the failing output and the model's last message. Calls and cost show in `/harness` and telemetry. A result with escalation on is a cascade result, not the session model alone.

## Configuration

`.midnight.server/harness.json` (requires project trust):

```json
{
	"checks": [
		{ "name": "types", "command": ["npx", "tsgo", "--noEmit"], "when": ["**/*.ts"], "level": 1 },
		{ "name": "unit", "command": ["npm", "test", "--", "--run"], "level": 3 }
	],
	"protect": ["test/**", "SPEC.md"],
	"maxRepairRounds": 1,
	"autoChecks": true,
	"features": { "contextPack": true },
	"escalation": { "model": "anthropic/claude-opus-5-5", "maxCallsPerPrompt": 1, "maxCallsPerSession": 6 },
	"shellTimeoutSeconds": 300
}
```

- `command` is an argument list, run without a shell. `{files}` expands to the changed files that matched `when`.
- `level` (1-3) places a check on the ladder; configured checks without one are level 1.
- Unknown keys and unknown feature names are rejected, so a typo does not silently disable anything.

Features, on by default: `parseGate`, `editRepair`, `pathHints`, `loopGuard`, `checkBaseline`, `driftGuard`, `blockerExit`. Off by default: `contextPack`, `lookup`, `diagnostics`, `escalation`.

Environment:

- `MIDNIGHT_SERVER_HARNESS=0` turns the harness off (plain Pi).
- `MIDNIGHT_SERVER_HARNESS_FEATURES=+contextPack,-driftGuard` switches features for one run (the eval uses this for ablations).
- `MIDNIGHT_SERVER_HARNESS_TELEMETRY=<file>` appends one JSON line per harness decision, including `hook_time` events with the milliseconds each hook took. Nothing is sent anywhere.

## Measuring it

`scripts/harness-eval.mjs` runs tasks with the harness off (`bare`), on (`harness`), and in ablated variants. It grades each run with hidden tests copied in after the agent exits. `node scripts/harness-eval-validate.mjs` checks that every task's starting state fails its grader and its reference solution passes.

```bash
node scripts/harness-eval-validate.mjs
node scripts/harness-eval.mjs --split dev --repeat 3 --jobs 4 -- --model <provider>/<model>
node scripts/harness-eval.mjs --variants bare,harness,pack=+contextPack -- --model <provider>/<model>
node scripts/harness-eval.mjs --report evals/harness/results/<file>.jsonl
```

The report gives the following per variant:

- pass rate;
- tokens per run and per solved task;
- cost per solved task (priced by the provider, cache reads and writes included);
- wall time per run and the harness's own time per run (`harness-s`, the sum of its hook times);
- the share of prompt tokens served from cache;
- turns, and turns before the first edit;
- false "done" claims;
- tool errors by class, and drift measures.

Against the first variant it gives the pass-rate difference with a 95% bootstrap interval over tasks and an exact McNemar test. `--manifest <file>` fixes every arm's feature assignment for a designed experiment (`scripts/harness-eval-design.mjs`).

## Limits

- The lean defaults have not yet been measured against plain Pi on larger repositories; `docs/WORKFLOW_PLAN.md` section 5 is the plan for that.
- Checks are only as good as the project's tests. A passing check means the command exited 0.
- The syntax gate needs the language's parser on the machine; without one the file is not checked.
- The baseline links ignored directories into a temporary copy; a check that writes into them (a build cache) writes into the real checkout.
