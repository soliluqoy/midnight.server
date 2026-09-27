# Luna design: decisions derived without running a model

Status (2026-09-27): every number below comes from data already on disk (pilot receipts, saved final changes, the review-state dataset, the task corpus) or from arithmetic on it. No model was run to produce this document. Where a number is an assumption rather than a measurement, it says so. This extends [the rebuild plan](HARNESS_REBUILD_PLAN.md); where they differ, this document's decisions are newer.

## 1. The question, stated honestly

Can a design make GPT-6 Luna reach GPT-6 Astra high's success on hard repository tasks?

The framing "as near as solving P = NP" points at the right structure and the wrong expectation. Nothing here bears on P versus NP. What carries over is the shape of NP: many coding tasks are search problems where **checking a candidate against a specification is much cheaper than finding one**. A design that exploits that shape turns Luna into a cheap generator of candidates and turns code into the checker. How far that goes is fixed by one quantity, the checker's soundness, which Section 3 derives and Section 4 measures.

## 2. What the existing data says (measured, no model run)

`evals/luna/evidence.py` reproduces the first five rows from the local results and review-state files; the retrieval row came from running `buildContextPack` on each task.

| Measurement | Source | Result |
| --- | --- | --- |
| Visible checks as a verifier on constructed wrong changes (partial fixes, weakened tests) | `evals/laya-review/data/review-states.jsonl`, 69 wrong and 129 right states, real check runs and hidden grader | False-accept rate 0.80 (partial fixes 0.58, weakened tests 0.81-1.00); true-accept 1.00 |
| Visible checks on real Luna + harness failures | pilots 01 and 02, 236 runs (contaminated task excluded) | **17 of 17** hidden failures passed the visible checks. The repair loop drives every run to visible green, so what remains is exactly what the visible checks cannot see. |
| Luna + harness success, short tasks | same | 0.88 (207/236); Luna bare 0.72; Astra bare 0.60 (its failures were edits to tests it was not told were protected) |
| How independent repeated attempts are | same, 14 tasks x 16 runs | Intra-task correlation 0.51. Failures cluster on tasks (`drift-email-conflict` 4/16, the rest near 16/16). pass@3 is 0.970 against 0.924 at one attempt; independent attempts would give 1.000. |
| Retrieval recall of the context pack | `buildContextPack` on all 38 tasks against the files their reference solutions change | 47/47 ranked, 42/47 inlined. The repositories have 2-21 files, so the corpus cannot measure retrieval at all. |
| Cost and time per run | receipts | Luna + harness $0.0007, median 34 s; Astra bare $0.1024, median 56 s. Luna is about 146 times cheaper per run. |

## 3. The governing equation

Model one task. Each Luna attempt is correct with probability `p`. The verifier accepts a correct attempt with probability `rho` (here 1.00) and a wrong one with probability `eps` (the false-accept rate). Retry until the verifier accepts or `n` attempts are spent:

```
q = p·rho + (1 − p)·eps                         chance an attempt is accepted
P(success) = p·rho · (1 − (1 − q)^n) / q        accepted and correct
```

Two facts follow directly:

1. **Precision is fixed by the verifier, not by `n`.** Every accepted attempt is correct with probability `p·rho / q`, whatever `n` is. More samples raise the chance that something is accepted, not the chance that the accepted thing is right. This is the result of Stroebl, Kapoor and Narayanan: resampling has an accuracy ceiling whenever the verifier has false positives.
2. **Attempts are not independent.** With intra-task correlation `icc`, the per-task `p` follows a Beta distribution with mean `m` and `a + b = (1 − icc)/icc`, and success averages the formula over it. Hard tasks stay hard on every attempt.

Calibration: with the measured values for Luna + harness on short tasks (`m` 0.924, `icc` 0.51, `eps` 1.0 on its residual failures) the model predicts 0.924 at every `n`. Retrying behind the current checks buys nothing, which matches the data.

`evals/luna/searchmodel.py` computes the tables below.

Extrapolation to hard tasks. **Assumed** single-attempt success: Luna 0.40, Astra high 0.60, so the claim needs Luna at 0.55 or more. `icc` 0.5:

| `eps` \ attempts | 1 | 2 | 3 | 5 | 8 |
| --- | --- | --- | --- | --- | --- |
| 0.8 (today's visible checks) | 0.40 | 0.43 | 0.43 | 0.43 | 0.43 |
| 0.5 | 0.40 | 0.46 | 0.48 | 0.48 | 0.49 |
| 0.3 | 0.40 | 0.49 | 0.52 | 0.54 | 0.55 |
| 0.2 | 0.40 | 0.50 | 0.54 | 0.57 | 0.59 |
| 0.1 | 0.40 | 0.51 | 0.56 | 0.61 | 0.64 |
| 0.0 | 0.40 | 0.52 | 0.59 | 0.66 | 0.71 |

With more diverse attempts (`icc` 0.3), `eps` 0.3 reaches 0.56 at 3 attempts and `eps` 0.1 reaches 0.70 at 5.

The largest `eps` at which Luna reaches 0.55 (`icc` 0.5): 0.15 with 3 attempts, 0.26 with 5, 0.29 with 8. With 2 attempts it is out of reach even with a perfect verifier.

**Conclusion.** The gap is closed by two levers, in this order: lower the verifier's false-accept rate from about 0.8 to about 0.25, and make attempts differ (lower `icc`). The number of attempts matters third. A retry-and-select design on top of today's visible checks is predicted to add at most 3 points. That is the main decision this document makes: **build the verifier before the search.**

## 4. Measuring the verifier without a model: mutation score over the change

Section 3 needs `eps` per change, at run time, without the hidden grader. Mutation analysis gives a proxy: change the lines the run changed in small ways (flip a comparison, swap `+`/`-`, `&&`/`||`, change a constant, delete a statement), discard mutants that do not parse, and run the checks. If the checks still pass on most mutants of the changed lines, they do not constrain those lines, and a wrong version of them would pass too.

Experiment (offline, no model): the pilots saved every run's final files. For 224 Luna + harness runs (13 tasks, contaminated task excluded) the workspace was rebuilt, up to 24 parsing mutants of the changed source lines were made (mean 11.6), and the task's visible checks were run on each. Scripts: `evals/luna/mutscore.py` (writes `evals/harness/results/mutscore.jsonl`) and `evals/luna/mutanalyze.py`, from `evals/harness/results/*.events/*.changes.json`.

| Result | Value |
| --- | --- |
| Runs whose visible checks pass at the end | 217, of which 17 fail the hidden grader |
| Mean kill rate, hidden pass vs hidden fail | 0.66 vs 0.46 |
| AUC of survival rate for hidden failure, pooled | 0.71 |
| AUC within tasks that have both outcomes | 0.94 (69 pairs, but only 5 failures in 3 tasks) |
| Flag runs with kill rate below 0.7 | flags 106/217 runs, contains 12/17 hidden failures |
| Flag below 0.9 | flags 179/217, contains 16/17 |

Per task, the kill rate ranges from 0.30 (`port-intent`) and 0.33 (`drift-task-sort`) to 1.00. It describes the task's tests as much as the run: several tasks where Luna always succeeded have weak tests (0.33-0.44), and they are the tasks where a wrong change would have passed unnoticed.

What this establishes:

- **The kill rate is a measurable, model-free estimate of verifier strength per change**, and it carries signal about hidden failure (AUC 0.71 pooled).
- **It is not a failure detector.** Flagging half the runs to catch 12 of 17 failures is too blunt for rejecting a change. It is the right signal for deciding where to spend effort: strengthen checks on low-kill requirements (step 5 below) and gate search on it (step 6).
- Caveats: 17 failures, 12 of them on one task (`drift-email-conflict`, whose protected test contradicts the request); equivalent mutants (changes that do not alter behavior) lower every kill rate; JS and Python only; short tasks. The within-task AUC rests on 5 failures and is not evidence by itself.
- The mean survival rate on correct runs, 0.34, is close to the `eps` range (0.25-0.30) that Section 3 says the claim needs. On these tasks, strengthening would need to take the typical change from about 0.66 to about 0.75 kill rate. That is a target, not a proof: simple mutants are easier to catch than realistic wrong changes (constructed partial fixes passed the visible checks 58% of the time, against 34% mutant survival), so survival underestimates `eps`. The receipt must therefore also cover requirements no check touches (class `none`), which mutation of changed lines cannot see.

## 5. The algorithm: receipt-gated search

Luna generates; code decides. Each step is deterministic except the Luna calls.

```
input: request, workspace
budget: attempts N (default 3, max 5), wall-time cap, dollar cap

1. Requirements.  Split the request into requirements R (one Luna call, or reuse the
   context-pack step). Each requirement gets a verifier class:
     exact   an oracle exists: type checker, formal verifier the repo already uses, or the
             old code itself when the requirement is "behavior unchanged" (refactor, port,
             rename): differential run of old vs new on generated inputs
     strong  a check that fails on the start state, passes on the change, and kills most
             mutants of the changed lines (Section 4)
     weak    passes, but survives mutation of the lines it should constrain
     none    no check touches it

2. Attempt.  Luna fast mode: context pack, edit gate, in-run checks, blocker rule (unchanged).

3. Receipt.  For each requirement: class, evidence (check, file, line), and the mutation
   kill rate of the changed lines under the checks that cover it.

4. Accept if every requirement is exact or strong. Done.

5. Strengthen, do not resample.  For each weak or none requirement, ask Luna for one targeted
   test. Keep a generated test only if (a) it fails on the start state (the requirement is new
   behavior) or passes on it (the requirement is preservation), (b) it passes on the candidate,
   (c) no protected test contradicts it, and (d) it raises the kill rate. Re-grade the receipt.
   Generated tests are never the only evidence for a requirement they alone define.

6. Search, only when the estimated eps is low enough to pay.  With the kill rate as the
   estimate of 1 − eps, the expected gain of one more attempt is
       gain(n) = P(success | n + 1) − P(success | n)       (Section 3 formula)
   Launch attempt n + 1 only while gain(n) · value > cost(attempt). Attempts are made diverse
   on purpose (lower icc): each starts from a different reading of the ambiguous requirements
   found in step 1, or a different first file, not from the same prompt resampled.

7. Select.  Among candidates with the best receipt, run every candidate against every kept
   test (existing and generated) and group candidates that behave identically: the dual
   execution agreement of CodeT. Pick the largest agreeing group whose members pass all exact
   verifiers; break ties by smallest diff. Agreement among wrong candidates is possible when
   they fail the same way (the correlated failures in Section 2), so agreement never outranks
   an exact verifier.

8. Report.  If no candidate reaches strong on every requirement, return the best one with
   its receipt: which requirements are verified, by what, and which are not. Never claim
   success for an unverified requirement (the blocker rule, extended from checks to
   requirements).
```

Why this order: step 5 lowers `eps` (the first lever), step 6 lowers `icc` (the second), and step 6 is gated by the first so attempts are only bought where they can pay (Section 3).

## 6. Where the named theories fit, and how niche they are

**Boolean Fourier analysis: useful, for experiment design only.** The harness has 13 on/off features; the success rate is a function on {−1, 1}^13. A factorial experiment estimates exactly its Fourier (Walsh) coefficients: main effects are the degree-1 coefficients, pairwise interactions degree 2. Two classic results make small experiments sufficient:

- **Friedgut's junta theorem**: a Boolean function with total influence `I` is `delta`-close to one depending on at most 2^O(I/delta) variables. In the pilots only `blockerExit` moved the outcome, so the total influence is small and a few features are expected to carry the effect. Measure those; decide the rest by their cost.
- **Low degree**: if interactions above order 2 are negligible, a regular resolution-V fractional factorial estimates all main effects and pairwise interactions of 13 factors with 256 arms instead of 8,192 (standard designs: 11 factors need 128, up to 17 need 256).

Structure makes it smaller still: most features act only when their trigger fires (the syntax gate only on a broken edit, rollback only on a repeated failure). A feature whose trigger never fires has zero effect by construction, so trigger frequencies from telemetry decide which features need an experiment at all. That needs no model run on the existing receipts.

**The sensitivity conjecture: niche here.** Huang (2019) proved that a Boolean function's degree is at most the square of its sensitivity. It would bound the interaction order from an observed sensitivity, but it applies to exact Boolean functions. The harness's success rate is a noisy real-valued estimate, and thresholding it at 50% does not make the bound transferable. It gives the intuition (few flip-sensitive features at every configuration means low-order interactions), not a usable rule. `evals/sensitivity-lab/` already says so; keep it as an analysis tool, not a runtime rule.

**Formal verification: niche as a general method, decisive where it applies.** Most repositories have no specification a verifier can check, so full verification is out of reach for general repo tasks. Its slices are the strongest verifiers available, and Section 3 says the verifier is the lever:

- type checkers, already ladder level 1;
- **differential equivalence** for any requirement of the form "behavior unchanged": the old code is a perfect oracle, so `eps` is near 0 and search is safe there. Refactors, renames and ports are this class;
- the repository's own verifier (Dafny, Lean, Verus) where it already exists, as a ladder level;
- property tests for pure functions, where the property follows from the specification.

**P versus NP: an analogy, not a technique.** The design uses the generate-cheaply, verify-exactly shape of NP. It does not make any search easier in the complexity sense; it moves the problem to building a sound verifier, which for natural-language requests is the hard part.

## 7. Decisions

| # | Decision | Evidence | Confidence |
| --- | --- | --- | --- |
| 1 | Build the verifier before the search: receipts, mutation kill rate, targeted-test strengthening (steps 3-5) | Section 3 table; 17/17 residual failures invisible to visible checks | High |
| 2 | Parallel attempts only behind the `eps` gate, made diverse by interpretation, default 3, max 5 | Section 3; icc 0.51 | High that ungated search fails; medium on the numbers (hard-task `p` assumed) |
| 3 | Differential equivalence as an exact verifier for "behavior unchanged" requirements, first language JS/TS | Section 6; the old code is a perfect oracle | High |
| 4 | Keep the deterministic features on (context pack, syntax gate, edit repair, path hints, loop notices, in-run checks, checkpoints, drift guard, blocker rule) | Zero token cost when not triggered; pilots show no harm, `blockerExit` measurable help | Medium |
| 5 | Do not invest in retrieval until a corpus with 500+ file repositories shows recall below 0.9 | Recall 47/47 on a corpus that cannot test it | High (as a stop rule) |
| 6 | Feature experiments: resolution-V fractional designs over triggered features only; untriggered features decided by cost | Section 6 | Medium |
| 7 | Escalation stays on (user decision); receipts record it; it does not replace the verifier, since advice cannot make a wrong accepted change detectable | Section 3 | High |
| 8 | Sensitivity-conjecture bounds are not used at runtime | Section 6 | High |

## 8. Model-free work to do next

1. Wrap the mutation kill rate (Section 4) as a harness module over the changed lines, reusing the ladder's check runner. Validate on the saved pilot changes, which is what Section 4 did offline.
2. Requirement receipts in the run receipt (per requirement: class, evidence, kill rate).
3. Differential equivalence for JS/TS pure functions: old vs new on generated inputs, bounded time.
4. A larger-repository corpus, so retrieval and long-task drift can be measured at all.
5. Only then the first model runs: the plan's Step 1, with receipt-gated search as a new arm.

## Sources

- Stroebl, Kapoor, Narayanan, [Inference Scaling fLaws: The Limits of LLM Resampling with Imperfect Verifiers](https://arxiv.org/abs/2411.17501) (2024)
- Chen et al., [CodeT: Code Generation with Generated Tests](https://arxiv.org/abs/2207.10397) (2022)
- Zhong, Raghunathan, Carlini, [ImpossibleBench: Measuring LLMs' Propensity of Exploiting Test Cases](https://arxiv.org/abs/2510.20270) (2025)
- Huang, [Induced subgraphs of hypercubes and a proof of the Sensitivity Conjecture](https://arxiv.org/abs/1907.00847), Annals of Mathematics 190 (2019)
- Friedgut, Boolean functions with low average sensitivity depend on few coordinates, Combinatorica 18 (1998)
- O'Donnell, Analysis of Boolean Functions (2014), for Fourier coefficients as factorial effects
