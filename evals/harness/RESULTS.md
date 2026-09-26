# Harness eval results

Runs of `scripts/harness-eval.mjs` on the four starter tasks. `harness` is the harness on; `bare` is `MIDNIGHT_SERVER_HARNESS=0`. Grading is by hidden tests copied in after the agent exits. Raw results are not committed (`evals/harness/results/` is ignored).

## 2026-09-27: cloud models, 3 repeats, thinking high

| Configuration | Pass | Tokens per run (in+out) | Cache reads per run | Time per run | List-price cost per run |
| --- | --- | ---: | ---: | ---: | ---: |
| `openai-codex/gpt-6-luna` + harness | 12/12 | 11,299 | 28,331 | 81 s | $0.0019 |
| `openai-codex/gpt-6-luna` bare | 12/12 | 6,545 | 14,123 | 105 s | $0.0011 |
| `openai-codex/gpt-6-astra` bare | 12/12 | 5,418 | 15,371 | 71 s | $0.0942 |

Every run passed, so these tasks cannot show whether the harness closes a gap between Luna and Astra: Luna bare already solves all of them. No check failed and no contract reminder fired in any harness run, so the extra 73% tokens are overhead from the `task` contract on small tasks. The 81 s vs 105 s time difference is partly one slow bare run (317 s).

Follow-ups: scale contract use with task size, and add harder tasks where Luna bare fails.

## 2026-09-27: local MiniCPM5-2B Q8_0, CPU, 1 repeat (stopped after 3 of 4 tasks)

| Task | harness | bare |
| --- | --- | --- |
| add-bug | pass, 2,696 tokens, 269 s | pass, 4,805 tokens, 308 s |
| csv-quotes | pass, but hit the 1,500 s timeout | fail (hidden tests) |
| port-intent | fail | fail |

The small model has real failures for the harness to address; one repeat is not enough to size the effect.
