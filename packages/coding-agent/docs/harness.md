# Harness

The harness is a built-in extension that makes whatever model runs the session more reliable and cheaper to run. It adds no model calls of its own: its gains come from grounded checks, explicit task intent, and a smaller context.

Every part works with any session model, cloud or local. The local-model profile applies only when the session model is the embedded MiniCPM model.

## What it does

### Checks before the run settles

Problem: a model says "done" after an edit that does not compile. You find out when you run the build yourself.

With checks configured, the harness runs them when the model finishes a run that changed files. If a check fails, the model gets the bounded output and one more turn to fix it, up to `maxRepairRounds` (default 2):

```
Harness checks failed after your changes (repair round 1 of 2).
[FAIL] types: npx tsgo --noEmit (exit 2, 8.4 s)
<output>
src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.
</output>
Fix the cause, then finish. Do not weaken, skip or delete the checks or the tests they run.
```

If the same checks fail again, the message asks the model to name the most likely root cause and one alternative before editing again. After the last round the harness stops and asks the model to report what still fails, instead of looping.

Changed files come from the `edit` and `write` tools. If a shell tool ran, the harness also asks `git status` for files modified during the run.

### Task contract

The `task` tool records what the user wants:

- the objective, including what the user implied but did not say
- constraints
- acceptance criteria that can be checked
- optionally, a short plan

The model marks each criterion `met`, `unmet` or `waived`, and must give evidence (a command and its result, a file and line) to do so.

Before the run settles, if any criterion is still open or unmet, the harness sends one reminder listing them, together with the latest check results. The model then verifies them or tells the user plainly what could not be met. There is one reminder per prompt, so it cannot loop.

The contract lives in the `task` tool results, so it follows `/tree` navigation. After compaction, the harness restores it as a message.

### Protected files

`edit` and `write` calls on protected paths are blocked with an explanation. `.midnight.server/harness.json` is always protected: a model that can edit the checks it is graded by can pass them without doing the work. List test files or specs you own in `protect`.

Shell commands are not inspected. Protection stops the common case (the model editing a test file to make it pass), not a determined workaround.

### Observation masking

Problem: every file the model read stays in every later request. Ten 15 KB reads cost ~37K tokens on each remaining turn.

The harness replaces old, large tool results with a one-line stub:

```
[read {"path":"src/app.ts"} output elided by the harness to save context (15.0 KB). Call the tool again if you need this content.]
```

The full result stays in the session file. Elision is recorded as `context_edit` entries, so it is persistent and branch-aware.

Masking waits until `batchBytes` (default 48 KB) are eligible, then elides them all at once. Changing an earlier part of the prompt invalidates the provider's prompt cache from that point on, so one batch costs one cache miss instead of one per turn. The newest `keepRecentResults` results (default 6), results under `minResultBytes` (default 2 KB), and `task` results are never elided.

### Interface repair

Some wrong tool arguments have exactly one sensible reading. The harness repairs them and tells the model what it did, so the next call is right:

- An absolute path whose top-level directory does not exist on this machine, such as `/workspace/math.js` (a sandbox path from training data), is mapped into the workspace when a matching file exists there (`math.js`). Real absolute paths are never rewritten.
- In PowerShell commands, POSIX null redirects become PowerShell ones: `2>/dev/null` becomes `2>$null`.
- Shell tool calls without a timeout get `shellTimeoutSeconds` (default 300). The tools have no default, so one unbounded command, such as `find /` walking a whole disk, could otherwise stall the run.

### Local-model profile

When the session model is the embedded local model:

- Only core tools stay active (`read`, `grep`, `find`, `ls`, `edit`, `write`, the shell tool, `task`). MCP gateways and other extension tools cost prompt tokens the 2B model rarely uses well. They come back when a different model drives the session.
- Tool output is capped at 6 KB (head and tail kept), with a hint to read a smaller range. The model's measured accuracy dropped on a 12 KB input.
- Project context files (`AGENTS.md`, `CLAUDE.md`) over 2 KB are listed in a `project_files` prompt section instead of being inlined, so the model reads them only when needed.
- Requests without a temperature use greedy decoding (temperature 0), which gave stable answers where sampling flipped between right and wrong.

### `delegate_local` self-check

For `inspect` and `plan` helper tasks, the helper asks the local model one constrained yes/no question: is the answer supported by the numbered lines? It reads the probability from the first token and reports it as the `self-check` check, failing below 50%. The question reuses the answer's cached prefix, so it costs the answer's tokens plus one generated token. It is a signal from the same model, not proof; the parent model should verify a failed self-check before relying on the answer.

## Configuration

Create `.midnight.server/harness.json` in the project. Its checks are commands the harness runs, so the file makes the project require trust, like project extensions and settings. Untrusted, the file is ignored. In non-interactive runs, pass `--approve` to trust the project.

```json
{
	"checks": [
		{ "name": "types", "command": ["npx", "tsgo", "--noEmit"], "when": ["**/*.ts"], "timeoutMs": 120000 },
		{ "name": "lint", "command": ["npx", "biome", "check", "{files}"], "when": ["**/*.ts", "**/*.json"] },
		{ "name": "unit", "command": ["npm", "test", "--", "--run"] }
	],
	"protect": ["test/**", "SPEC.md"],
	"maxRepairRounds": 2,
	"contract": true,
	"masking": { "enabled": true, "keepRecentResults": 6, "minResultBytes": 2000, "batchBytes": 48000 },
	"localProfile": true,
	"shellTimeoutSeconds": 300
}
```

- `command` is an argument list, run without a shell. On Windows, `npm` and `npx` resolve to their `.cmd` shims.
- `{files}` expands to the changed files that matched `when`.
- A check with `when` runs only if a changed file matches it. A check without `when` runs after any change.
- `timeoutMs` defaults to 300000. Output is capped at 64 KB, and the model sees the first 1.5 KB and last 4.5 KB.
- Unknown keys are rejected, so a typo does not silently disable a check.

`MIDNIGHT_SERVER_HARNESS=0` turns the whole harness off. `/harness` shows the current checks, protected paths, contract, and how much context masking has saved.

## Measuring it

`scripts/harness-eval.mjs` runs the same tasks with the harness on (`harness`) and off (`bare`) and grades each run with hidden tests that are copied in only after the agent exits. A run fails if it changed a file the task marks `unchanged`, such as the test it was meant to satisfy.

```bash
node scripts/harness-eval.mjs --repeat 3 -- --local
node scripts/harness-eval.mjs --only port-intent,csv-quotes -- --model <provider>/<model>
```

It prints pass rate, tokens, prompt-cache reads, cost and time per variant, and writes one JSON line per run to `evals/harness/results/`. The tasks are in `evals/harness/tasks/`. Each task has a `files/` workspace, a `hidden/` grader, a prompt, and `task.json`; a reference solution for each is in `evals/harness/reference/`. Runs with a cloud model cost real tokens.

The starter tasks test different things:

| Task | What it tests |
| --- | --- |
| `add-bug` | A visible bug with a visible test (sanity) |
| `port-intent` | Requirements the prompt implies but does not list |
| `test-trap` | Fixing the code instead of editing the failing test |
| `csv-quotes` | An underspecified request ("standard CSV") with implied cases |

Four tasks do not make a benchmark. Add tasks from real work, and compare variants over several repeats before trusting a difference.

## Limits

- The harness improves reliability and cost; it does not add knowledge the model lacks. How much it helps depends on the model and the task, and it has not yet been measured against an evaluation corpus.
- Checks are only as good as the project's tests. A passing check means the configured commands exit 0, not that the change is correct.
- The contract reminder relies on the model's own evidence. The harness checks that evidence was given, not that it is true; configured checks are the ground truth.
