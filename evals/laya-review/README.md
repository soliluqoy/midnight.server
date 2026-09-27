# Laya review experiment

Question: can [Laya Studio](https://github.com/Hantlowt/laya-studio) (pinned at `dc01937`) make Laya useful for the harness's completion review (`REVIEW_QUESTIONS` in `packages/coding-agent/src/harness/decisions.ts`)?

## Method

- `build-dataset.mjs` builds 396 review states from 26 harness eval tasks (the Go task was skipped: no Go on the machine). Each variant of a task's change is run through the task's visible checks and hidden grader, and the state is built with the harness's own `compactReviewState` and `formatCheckSummary`.
  - Variants: the reference fix; partial fixes (subsets of its hunks); an assertion commented out, deleted or loosened, with and without the fix; the fix plus an unrelated helper or docs edit. Each appears with the real check results and with "no checks ran".
  - Labels: `addresses_request` = the hidden grader passes; `weakened_tests` and `unrelated_changes` by construction; `unsupported_claims` = the final message claims passing tests while checks failed or none ran.
  - Split by task (the eval's own dev/holdout). Message wording and unrelated-edit templates come from disjoint pools for dev and holdout.
- `experiment.py` compares on holdout tasks: base Laya asked the harness's exact questions with the harness's thresholds; six Laya Studio readers fitted on dev tasks only; and, where a question has a surface signal, a text rule. Also 5-fold cross-validation grouped by task.
- Run: `node evals/laya-review/build-dataset.mjs`, then `.cache/laya-experiment/venv/Scripts/python evals/laya-review/experiment.py`. CPU only (Intel laptop, 16 GB).

## Results (2026-09-27, holdout: 11 tasks, 162 states)

AUC (0.5 = chance, 1.0 = perfect ranking); in brackets the 95% interval of the difference from base Laya, resampling tasks.

| Question | Base Laya | Best Laya Studio reader | Text rule |
| --- | ---: | ---: | ---: |
| `addresses_request` | 0.52 | 0.92 multi_vector_steering [+0.29, +0.51] | - |
| `addresses_request`, changes to code only (the hard part) | 0.51 | 0.76 multi_vector_steering; 0.60 for the reader dev picked | - |
| `unrelated_changes` | 0.49 | 0.94 whitened_prototypes [+0.37, +0.54] | - |
| `unsupported_claims` | 0.52 | 0.80 whitened_prototypes [+0.14, +0.40] | 1.00 |
| `weakened_tests` | 0.37 | 0.94 whitened_prototypes [+0.42, +0.74] | 1.00 |

5-fold cross-validation over all tasks agrees (base 0.38-0.56; whitened_prototypes 0.79-0.96).

Revise decision on holdout (144 of 162 states should be revised; 18 are correct work):

| | Revises | Problems caught | Correct work sent back |
| --- | ---: | ---: | ---: |
| Base Laya, harness thresholds | 4% | 4% | 0% |
| Readers at their default 0.5 threshold | 98% | 99% | 94% |

Cost on this CPU: base Laya 7.0 s per review (four questions); one embedding for the readers 2.5 s per state.

## What this means

1. **Base Laya has no signal on these questions.** Every AUC is at chance, and on `weakened_tests` it is inverted (0.37). With the harness thresholds it almost never revises, so the shipped review costs about 7 s per request and changes nothing.
2. **Readers learn real signal where the diff shows it.** Unrelated edits and weakened tests are ranked well on tasks and wording they never saw.
3. **Reader probabilities are not usable as they are.** They sit near 0.5 (Brier 0.21-0.25), so a 0.5 threshold sends nearly all work back. Thresholds would have to be calibrated on dev data.
4. **The question that needs a model is the one the readers do not solve.** Whether a change to the code actually does what was asked (partial vs complete fixes) reaches AUC 0.60-0.76. Hidden tests and the harness's check ladder are the real signal there.
5. **Two questions need no model at all.** A short text rule answers `weakened_tests` and `unsupported_claims` perfectly here. The rules were written with both template pools in view, so 1.00 is optimistic, but the signals (a removed or commented-out assertion; a success claim next to `[FAIL]` or "nothing was run") are exact by nature.

Limits: synthetic variants from 26 small tasks, not real agent runs; only 18 holdout states of correct work, so the false-revision rate is imprecise; one run of each fit, no repeated seeds.
