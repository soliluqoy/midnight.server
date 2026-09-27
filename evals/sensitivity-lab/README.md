# midnight.server sensitivity laboratory

This is an offline scientific-computing prototype, not a midnight.server extension.
It uses Python 3.10+ and the standard library. It makes no network calls, loads no
models, and modifies no repository. All included data are synthetic.

## Run

From this extracted directory:

```bash
python harness_lab.py demo --out out
python -m unittest -v test_harness_lab.py
python harness_lab.py analyze --runs out/synthetic-runs.jsonl --manifest out/synthetic-manifest.json --out out/reanalyzed.json
```

On Linux, use `python3` if that is the Python 3 executable. On Windows, `py -3`
can be used instead of `python`. Outputs are overwritten when the same paths
are reused. `demo` writes only inside the specified output directory.

## What works now

- Exact local/max sensitivity, block sensitivity, and real polynomial degree
  for small deterministic Boolean truth tables.
- Independent edge-based and Fourier-based total influence calculations.
- Fast Walsh-Hadamard transform and full-factorial main/pair interaction contrasts.
- Exact cost-optimal query ordering for a fixed Boolean policy with independent,
  uniformly distributed input bits and known query costs.
- Synthetic noise controls and planted-interaction recovery.
- Complete-block, cluster-aware exploratory analysis of normalized real data.
- Rejection of missing cells, unbalanced repetitions, duplicate runs, and missing
  completion/timeout/budget labels.

No Laya adapter, evidence builder, live model runner, calibrated classifier,
sparse optimizer, or production routing controller is implemented here. The
engineering specification defines those integration steps.

## Mathematical conventions

Truth-table position `mask` is the vector with factor i at bit i. In a two-factor
table, positions 0, 1, 2, 3 mean neither, factor 0 only, factor 1 only, both.
The Walsh basis uses `x_i = (-1)**bit_i`: enabled means -1. Consequently a positive
on-minus-off main effect corresponds to a negative singleton coefficient.

Boolean routines accept integer 0/1 tables only. The scientific analyzer works
on estimated success probabilities; it deliberately does not assign them an
exact Boolean sensitivity or degree. High-order noisy coefficients are not
evidence of true high-order dependence without repeated-data validation.

## Real experiment input

`analyze` is a working numeric input interface, not a reader for the current
midnight.server runner's native JSONL format. Normalize records explicitly.

Manifest:

```json
{"factors": ["contextPack", "inRunChecks"]}
```

One normalized run per JSONL line:

```json
{"run_id":"exp1-task1-0-00","task_id":"task1","cluster_id":"repo1","repeat":0,"factors":{"contextPack":false,"inRunChecks":false},"artifact_passed":true,"completed":true,"timed_out":false,"over_budget":false}
```

Supply every configuration for every task with the same repetition identifiers
within that task. A failed execution is a record with the appropriate failure
labels, not a deleted row. Factor values must be the verified treatment
assignment; instrument feature resolution before using nominal settings.

Mapping from the current runner requires care:

| Normalized field | Mapping or collection requirement |
|---|---|
| task_id | `task`, scoped to a fixed dataset version |
| repeat | `repeat` |
| cluster_id | Explicit repository/task-family map; do not assume every prompt is independent |
| factors | Explicit design manifest plus resolved-feature telemetry; do not split comma strings heuristically |
| artifact_passed | Independent grader result; native `passed` conflates over-budget handling, so expose the original grader result |
| completed | Explicit normal terminal completion; do not equate a passing workspace with completed execution |
| timed_out | `timedOut` |
| over_budget | `overBudget` with complete resource accounting |
| run_id | Stable experiment/task/configuration/repetition identifier |

Keep one fixed experiment cohort per analysis file: generator snapshot, harness
commit, task split, grader version, question version, resource budget, and
hardware profile. Grouping incompatible cohorts invalidates the comparison.
The simple analyzer cannot verify these external conditions.

The estimated target gives equal weight to independent clusters, then equal
weight to tasks within a cluster. Choose clusters before analysis. If the desired
deployment population needs different weights, implement that estimand explicitly.

Intervals are ordinary pointwise cluster bootstrap intervals. They do not provide
simultaneous coverage across many selected effects, permit repeated significance
checking, or certify population-level benefit from a small curated task set.
They assume enough independent representative clusters. They are exploratory.

## Included demonstration results

`out/demo-results.json` and the 3,840 synthetic run records are reproducible with
the fixed seeds in the code. The planted probabilities are 0.30, 0.32, 0.31, 0.70;
their interaction is 0.37. The demo estimates 0.371875 with a pointwise 95% cluster
bootstrap interval approximately [0.3198, 0.4219]. These factor labels refer to a
fabricated numerical response surface, not measured feature behavior.

The unchanged-condition control has known causal effect zero and observed
disagreement 0.4936. The Boolean policy query example reduces expected query
cost from 11 to 6 abstract units under its stated synthetic prior. Neither is
a measured latency or accuracy improvement in midnight.server.

## Validation

Nine tests cover independently computed transform values, transform inversion,
all 256 Boolean functions in dimension three, the signed hypercube matrix
identity in dimensions one through five, local-sensitivity counterexamples,
known query costs, effect signs, timeout semantics, input integrity, and cluster
weighting. Numerical checks are not proofs for arbitrary dimension.

## Intended next use

1. Verify this lab locally.
2. Add truthful run and decision receipts to midnight.server.
3. Export a small complete factorial dataset in this schema.
4. Analyze effects without changing the frozen comparison policy.
5. Confirm a chosen policy on a new task/repository split.

Do not use synthetic results to claim that the harness improves a model.
