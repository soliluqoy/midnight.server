# Making Luna and Sol better: research checkpoint

## Decision

The goal is higher task quality from the **same model**, not a larger prompt, a larger tool catalog, or unreported extra attempts. This first research pass has **not demonstrated an accuracy improvement**. Two hypotheses were implemented and evaluated; neither earned a default rollout. Production harness behavior is unchanged.

This is a bounded research checkpoint, not an exhaustive survey or a completed capability upgrade. Research abstracts motivate experiments; they do not prove a technique will transfer to GPT-6 Luna or Sol. These model names were observed in the configured provider's response events, not independently verified as public model releases.

## Implemented and measured

### 1. Diversity-aware context selection: rejected for rollout

Problem: independently ranked files can repeat one part of a request and omit another. For example, three parser implementations can occupy the context while the requested writer is missing.

Implemented `packages/coding-agent/src/harness/context-selection.ts`, a dependency-free greedy selector over a bounded lexical candidate pool. It maximizes:

`F(S) = sum(i in S) relevance(i) + 2 * sum(query facet t) max(i in S) evidence(i, t)`

Evidence weights use inverse document frequency. Path/declaration matches receive stronger weight than body mentions. Relevance is normalized by the highest candidate score. The pool is the existing ranker's top 40 for the default ten-file selection. The coefficient and pool size were fixed before the first benchmark and were not tuned after seeing results.

For finite nonnegative weights, this objective is monotone and submodular: adding another file offers less benefit when its evidence is already covered. Greedy selection has the standard `1 - 1/e` cardinality approximation guarantee. **That guarantee applies only to this objective within the candidate pool, not to task correctness or context-token packing.** A better solution to a bad surrogate can still make the product worse.

Evaluated all 23 SWE-bench Lite **dev** issues at their pinned base commits, across six repositories with 42–2,155 indexed files. The rankers received issue text and base-tree indexes only. Reference patch paths were used exclusively by the scorer; patch contents were not passed to either ranker. No downloaded repository code was executed.

| Metric | Existing ranker | Coverage selector |
| --- | ---: | ---: |
| Mean changed-file recall, top 5 | 78.26% | 73.91% |
| Mean changed-file recall, top 10 | 86.96% | 82.61% |
| Mean reciprocal rank, top 10 | 0.6170 | 0.5899 |
| All changed files found, top 10 | 20/23 | 19/23 |

No gold paths were excluded as unindexable in this run. The selector lost `pylint-dev__astroid-1978` from the top ten. All per-issue paths, exclusions, index truncation flags, and metrics are in [retrieval-results.json](retrieval-results.json). A second extraction through the committed downloader reproduced the aggregate metrics exactly.

**Decision:** do not connect this selector to `buildContextPack` or enable it by default. It is currently imported only by the offline evaluator and its tests. No claim about model accuracy follows from localization alone.

### 2. Evidence-and-counterexample workflow: no gain in a ceiling-limited pilot

Added the opt-in example skill at `packages/coding-agent/examples/skills/verified-exploration/`. Its workflow asks for a concrete contract, a discriminating observation, specification-derived counterexamples, and at most two genuinely different approaches when warranted. It does not mandate extra agents or a stronger model.

Preselected `drift-banker-round`, `drift-money-format`, and `drift-stream-lines` from the existing dev corpus. Validated broken/reference fixtures before calling either model. Compared the current harness with escalation disabled against that same configuration with the workflow appended to the system prompt. Reasoning was `high`; each task had one attempt per arm/model, a 240-second timeout, and a $0.30 usage-triggered stop. Local delegation and the separate drift watcher were disabled; the normal harness drift guard remained enabled in both arms.

| Model | Arm | Artifact-correct | Mean seconds | Total reported cost |
| --- | --- | ---: | ---: | ---: |
| GPT-6 Luna | Current harness | 3/3 | 42.94 | $0.002026 |
| GPT-6 Luna | Harness + workflow | 3/3 | 48.01 | $0.002961 |
| GPT-6 Sol | Current harness | 3/3 | 55.86 | $0.062418 |
| GPT-6 Sol | Harness + workflow | 3/3 | 76.61 | $0.114216 |

Total reported usage cost: **$0.181621**. This uses provider/catalog accounting, not an independently audited invoice. Four arm/model processes ran concurrently, each with two workers, so latency is descriptive rather than an isolated speed benchmark. Costs include the additional prompt. Usage-triggered stopping can overshoot during an in-flight request.

The banker-rounding task intentionally has a visible test conflicting with the requested behavior; artifact grading, unchanged-file checks, and the task's explicit requirements determine success. A visible test failure must not be silently reclassified as a product failure or a reason to weaken the request.

All 12 runs are included in [workflow-results.json](workflow-results.json), with observed model names, resolved feature flags, raw-event hashes, and the exact workflow hash. There were no additional attempts selected after looking at results. Full event files remain in the git-ignored `evals/harness/results/premise-workflow-*.events/` directories.

**Decision:** keep the skill explicitly opt-in. The pilot shows overhead and no accuracy gain; it cannot establish general equivalence, harm, or benefit. It tests forced workflow content, **not** automatic skill discovery, creative quality, or official SWE-bench task resolution. It also compares against the current harness, not a bare agent.

## Research map and priorities

[Sources and limits](RESEARCH.md) explains the primary references. [sources.json](sources.json) records downloaded URLs, hashes, and review scope. Most paper review in this pass was abstract-level triage, not full-paper replication.

| Path | Concrete mechanism | Decision / missing evidence |
| --- | --- | --- |
| Tool interface, structured edits, compiler/LSP feedback | Replace guessing with definitions, valid edit shapes, diagnostics | Preserve existing harness features; isolate each contribution in future ablations |
| Retrieval and context compression | Supply relevant evidence without flooding the model | Existing ranker beats our first selector; investigate actual missed evidence before adding embeddings |
| Independent verification | Public reproductions, contract-derived properties, independent regression tests | Highest next priority; model-generated tests alone are not an oracle |
| Bounded alternative search | Two isolated candidate patches; select using frozen external checks | Implement/evaluate after the containerized task runner; charge for both candidates, not just the winner |
| Adaptive test-time compute | Spend additional attempts only when observable uncertainty warrants them | Needs a difficulty signal and equal-budget baselines; do not treat self-reported confidence as calibrated |
| MCTS / bandit allocation | Reallocate attempts using measured verifier outcomes | Defer: expensive rollouts and a misleading reward can amplify test overfitting |
| Self-consistency / voting | Aggregate independent answers | Useful for canonical answers; patch majority is not a correctness test and errors are correlated |
| Reflection / memory | Store concise externally confirmed failure lessons | Defer persistent memory until isolation, expiry, provenance, and held-out transfer tests exist |
| Skills | Load narrow procedures only when their conditions apply | Added one manual example; its first pilot did not improve accuracy |
| MCP documentation tools | Retrieve authoritative library/version facts | Context7 is a candidate for a version-sensitive API task set, not a general intelligence upgrade |
| MCP browser tools | Inspect rendered UI and reproduce browser failures | Playwright MCP is a candidate for UI tasks; permissions, browser state, and page injection require isolation |
| Creativity / diverse design | Generate different mechanisms, then test constraints and compare blind | Needs a separate rubric; code-fix pass rate cannot establish originality or usefulness |
| Formal methods / solvers | Check a bounded arithmetic, type, protocol, or scheduling obligation | High precision in suitable domains; translate the actual contract rather than solving a convenient surrogate |
| Fine-tuning / learned policies | Learn retrieval, verifier, or budget policies from independent examples | No model-weight access assumed; first collect provenance-preserving, non-holdout evidence |
| Stronger-model escalation | Substitute capability from another model | Separate product offering and accounting; not evidence that Luna or Sol themselves improved |

No MCP servers, npm dependencies, credentials, global skills, or user settings were installed or modified in this pass. Downloaded snapshots remain outside the project, with original repository licenses retained. New TypeScript code has no external dependency.

## Reproduce

Requires Node 22.18+ (tested on Node 24), Python 3.12+, and `curl` with working TLS verification. Start with a **new, short, external directory** on Windows. Approximately 292 MB of compressed repository snapshots are downloaded, plus extracted trees. The downloader verifies metadata/archive SHA-256 values, rejects unsafe paths, skips links/special files, limits expansion, and refuses to reuse existing extracted trees. It never installs or executes their code. If an upstream hash changes, review it rather than automatically accepting new data.

```powershell
python -B scripts/harness_fetch_swe_lite.py --out "$env:TEMP/swe-premise-fresh"
node scripts/harness-retrieval-eval.mjs "$env:TEMP/swe-premise-fresh/manifest.json" "$env:TEMP/swe-premise-fresh/results.json"
```

The manifest contains evaluator-only answer paths. Never place it, the metadata's gold patches, or hidden graders in an agent's task workspace. Public benchmark training contamination is still possible; fresh independently authored tasks are needed for confirmatory capability claims.

Run the workflow pilot once per model and arm, choosing **new** output names (the existing runner appends). These commands spend provider quota:

```powershell
$env:MIDNIGHT_SERVER_DRIFTWATCH = '0'
$model = 'openai-codex/gpt-6-luna' # repeat separately with gpt-6-sol
$workflow = (Resolve-Path packages/coding-agent/examples/skills/verified-exploration/workflow.md).Path
node scripts/harness-eval.mjs --only drift-banker-round,drift-stream-lines,drift-money-format --split dev --variants 'baseline=-escalation' --repeat 1 --jobs 2 --timeout 240 --max-cost 0.30 --out evals/harness/results/my-baseline.jsonl -- --model $model --thinking high --no-extensions --no-skills --no-context-files --no-prompt-templates --no-themes --exclude-tools delegate_local --offline
node scripts/harness-eval.mjs --only drift-banker-round,drift-stream-lines,drift-money-format --split dev --variants 'evidence=-escalation' --repeat 1 --jobs 2 --timeout 240 --max-cost 0.30 --out evals/harness/results/my-evidence.jsonl -- --model $model --thinking high --no-extensions --no-skills --no-context-files --no-prompt-templates --no-themes --exclude-tools delegate_local --offline --append-system-prompt $workflow
```

Restore any previous drift-watcher environment value after the experiment. To manually use the skill rather than force its content, load its `SKILL.md` with the CLI's `--skill` option and invoke `/skill:verified-exploration`.

Focused implementation checks:

```powershell
node --test scripts/harness-retrieval-eval.test.mjs
python -B -m unittest discover -s scripts -p test_harness_fetch_swe_lite.py -v
# From packages/coding-agent:
node ../../node_modules/vitest/dist/cli.js --run test/harness-context-selection.test.ts
```

## Next acceptance gate

1. **Build the isolated solve evaluator first.** Docker initially failed to respond but later returned an engine version successfully. Official SWE-bench containerized correctness runs were not performed in this pass. The new retrieval evaluator is not a replacement. Validate each chosen task's broken base and reference fix with the official harness before running models; pin the evaluator, images, and source commits. Do not execute downloaded code on the host or expose provider credentials to task containers.
2. **Use difficult but valid development tasks.** Current small tasks have a ceiling effect. Start with stratified real-repository dev issues and diagnose unsuccessful runs without reading holdout outcomes. Include navigation, multi-file contracts, algorithmic edge cases, and dependency/version uncertainty.
3. **Freeze the actual comparison.** Compare bare, current harness, and one targeted new mechanism, separately for Luna and Sol. Use the same task set and reasoning level. Report both equal per-task resource limits and quality/cost trade-offs. A two-attempt method must also face a budget-matched two-attempt baseline; reporting hidden-oracle `pass@2` as deployable selected-patch accuracy is invalid.
4. **Keep grading independent.** Public checks may guide search; hidden checks may only score the final frozen patch. Freeze the candidate-selection rule before seeing hidden outcomes. Record invalid attempts, timeouts, cost overruns, test tampering, and environment failures rather than dropping them.
5. **Use paired task-level statistics.** Repeat runs, but treat the task—not each correlated seed—as the sampling unit. Report paired differences with uncertainty and repository clustering when supported by the sample size. Freeze the final sample size before testing; use appropriate sequential corrections if repeatedly peeking. Do not interpret the degenerate bootstrap interval of three all-pass tasks as certainty.
6. **Test creativity separately.** On held-out open-ended tasks, require correctness/feasibility first, then blind randomized human comparisons of usefulness and originality. Show raters neither model nor harness identity. Model self-grading is supplementary only.
7. **Promote only demonstrated value.** Require a predeclared useful improvement with acceptable cost, latency, safety, and regression results. Publish negative results. Keep unproven candidates off by default.
