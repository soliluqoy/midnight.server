"""Laya review experiment: base Laya vs Laya Studio readers on the harness review questions.

Reads data/review-states.jsonl (build-dataset.mjs) and compares, per review question:

- base: Laya itself, asked the harness's exact questions (data/questions.json) about the exact
  state the harness sends, with the harness's thresholds for its revise decision.
- Laya Studio strategies: small readers over frozen Laya, fitted on dev tasks only.
- rule: a few lines of text matching, where the question has a surface signal (a reference
  point: if code can answer it, no model is needed).

Protocols:
- holdout: fit on dev tasks, test on holdout tasks (the eval's own split). Primary.
- cv: 5-fold cross-validation grouped by task over all tasks, for embedding readers. Checks
  that the holdout result is not an accident of one split.

Metrics per question: AUC (threshold-free), balanced accuracy at the decision threshold, Brier
score, and a task-level bootstrap interval for the AUC difference against base Laya. Then the
combined revise decision the harness makes, including how often it would send correct work
back (false revisions).

Usage (from the repository root, in the experiment venv):
  .cache/laya-experiment/venv/Scripts/python evals/laya-review/experiment.py [--steering]
"""

from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

import numpy as np
from laya.common import serialize_state
from laya_studio.backends import create_backend
from laya_studio.schemas import DecisionSchema, Example, TaskSpec
from laya_studio.strategies import create_strategy

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
QUESTIONS = ["addresses_request", "unrelated_changes", "unsupported_claims", "weakened_tests"]
# The harness's revise thresholds (REVIEW_THRESHOLDS in decisions.ts). For addresses_request a
# problem is a LOW probability; for the others a HIGH one.
HARNESS_FLAG = {
    "addresses_request": lambda p: p < 0.3,
    "unrelated_changes": lambda p: p > 0.85,
    "unsupported_claims": lambda p: p > 0.85,
    "weakened_tests": lambda p: p > 0.8,
}
EMBEDDING_STRATEGIES = [
    "nearest_prototype",
    "multiclass_centroids",
    "contrastive_vector",
    "whitened_prototypes",
    "residual_embedding_transform",
    "multi_vector_steering",
]
LABELS = ["no", "yes"]


# ---------------------------------------------------------------------------
# Metrics.


def auc(scores: np.ndarray, labels: np.ndarray) -> float:
    """Probability that a random positive scores above a random negative (ties count half)."""
    pos, neg = scores[labels == 1], scores[labels == 0]
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    greater = (pos[:, None] > neg[None, :]).sum() + 0.5 * (pos[:, None] == neg[None, :]).sum()
    return float(greater / (len(pos) * len(neg)))


def balanced_accuracy(predicted: np.ndarray, labels: np.ndarray) -> float:
    rates = [np.mean(predicted[labels == c] == c) for c in (0, 1) if np.any(labels == c)]
    return float(np.mean(rates))


def brier(scores: np.ndarray, labels: np.ndarray) -> float:
    return float(np.mean((scores - labels) ** 2))


def bootstrap_auc_diff(tasks, scores_a, scores_b, labels, reps=2000, seed=7):
    """95% interval of AUC(a) - AUC(b), resampling whole tasks."""
    rng = np.random.default_rng(seed)
    unique = sorted(set(tasks))
    index = {t: np.array([i for i, x in enumerate(tasks) if x == t]) for t in unique}
    diffs = []
    for _ in range(reps):
        rows = np.concatenate([index[t] for t in rng.choice(unique, len(unique))])
        a, b = auc(scores_a[rows], labels[rows]), auc(scores_b[rows], labels[rows])
        if not (np.isnan(a) or np.isnan(b)):
            diffs.append(a - b)
    return float(np.percentile(diffs, 2.5)), float(np.percentile(diffs, 97.5))


# ---------------------------------------------------------------------------
# Rules (reference point).

CLAIM = re.compile(r"(all|every\w*)\s+(tests?\s+|checks?\s+)?pass|tests? (are )?passing|suite is green", re.I)
WEAKENED = re.compile(
    r"^-\s*(assert\b|expect\().*$|^\+\s*(//|#)\s*(assert\b|expect\()|^\+.*assert\.ok\(.*!== undefined\)|^\+.*assert .* is not None",
    re.M,
)


def rule_scores(rows, question):
    if question == "unsupported_claims":
        return np.array(
            [
                1.0
                if CLAIM.search(r["state"]["final_message"])
                and ("[FAIL]" in r["state"]["change"]["checks"] or "nothing was run" in r["state"]["change"]["checks"])
                else 0.0
                for r in rows
            ]
        )
    if question == "weakened_tests":
        return np.array([1.0 if WEAKENED.search(r["state"]["change"]["diff"]) else 0.0 for r in rows])
    return None


# ---------------------------------------------------------------------------
# Models.


def task_spec(question: str, definition: dict) -> TaskSpec:
    criteria = definition.get("criteria") or {}
    descriptions = {}
    if criteria.get("false"):
        descriptions["no"] = criteria["false"]
    if criteria.get("true"):
        descriptions["yes"] = criteria["true"]
    return TaskSpec(
        name=question,
        description=definition["instructions"],
        domain="code-review",
        decision=DecisionSchema(
            type="noul", labels=LABELS, question=definition["instructions"], class_descriptions=descriptions
        ),
    )


def examples(rows, question, split):
    return [
        Example(
            id=r["id"],
            input=r["text"],
            label=LABELS[r["labels"][question]],
            split=split,
            task_name=question,
            domain="code-review",
        )
        for r in rows
    ]


def base_scores(backend, rows, questions):
    """Base Laya answers, cached: the slow part on CPU."""
    cache_path = DATA / "base-answers.jsonl"
    cache = {}
    if cache_path.exists():
        for line in cache_path.read_text(encoding="utf-8").splitlines():
            item = json.loads(line)
            cache[item["id"]] = item
    missing = [r for r in rows if r["id"] not in cache]
    started = time.perf_counter()
    with cache_path.open("a", encoding="utf-8") as out:
        for n, r in enumerate(missing, 1):
            t0 = time.perf_counter()
            result = backend.agent.system_one(r["state"], questions)
            item = {
                "id": r["id"],
                "ms": (time.perf_counter() - t0) * 1000,
                "p": {q: float(result["answers"][q]["noul"]) for q in QUESTIONS},
            }
            cache[r["id"]] = item
            out.write(json.dumps(item) + "\n")
            out.flush()
            if n % 25 == 0:
                print(f"  base Laya: {n}/{len(missing)} ({(time.perf_counter() - started) / n:.2f} s/state)", flush=True)
    return cache


def fit_predict(strategy_name, spec, train_rows, test_rows, question, backend, rng):
    """Fit on train_rows (split into specialization/validation by task), predict test_rows."""
    tasks = sorted({r["task"] for r in train_rows})
    rng.shuffle(tasks)
    validation_tasks = set(tasks[: max(1, len(tasks) // 5)])
    specialization = [r for r in train_rows if r["task"] not in validation_tasks]
    validation = [r for r in train_rows if r["task"] in validation_tasks]
    fitted = create_strategy(strategy_name).fit(
        spec,
        examples(specialization, question, "specialization"),
        examples(validation, question, "validation"),
        backend,
    )
    predictions = fitted.predict([r["text"] for r in test_rows])
    return np.array([p["probabilities"]["yes"] for p in predictions])


def grouped_cv(rows, names, k, spec, question, base, backend):
    """AUC per method under k-fold cross-validation grouped by task."""
    order = np.random.default_rng(3).permutation(sorted({r["task"] for r in rows}))
    folds = [set(order[i::k]) for i in range(k)]
    result = {}
    for name in names:
        predicted, truth = [], []
        for fold in folds:
            test = [r for r in rows if r["task"] in fold]
            train = [r for r in rows if r["task"] not in fold]
            if name == "base":
                predicted.extend(base[r["id"]]["p"][question] for r in test)
            else:
                predicted.extend(fit_predict(name, spec, train, test, question, backend, np.random.default_rng(1)))
            truth.extend(r["labels"][question] for r in test)
        result[name] = auc(np.array(predicted), np.array(truth))
    return result


# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--steering", action="store_true", help="also run activation_steering (slow on CPU)")
    args = parser.parse_args()

    rows = [json.loads(line) for line in (DATA / "review-states.jsonl").read_text(encoding="utf-8").splitlines()]
    for r in rows:
        r["text"] = serialize_state(r["state"])
    questions = json.loads((DATA / "questions.json").read_text(encoding="utf-8"))["questions"]
    dev = [r for r in rows if r["split"] == "dev"]
    holdout = [r for r in rows if r["split"] == "holdout"]
    print(f"{len(rows)} states: {len(dev)} dev ({len({r['task'] for r in dev})} tasks), "
          f"{len(holdout)} holdout ({len({r['task'] for r in holdout})} tasks)")

    t0 = time.perf_counter()
    backend = create_backend("pytorch", "convaiinnovations/laya", device="cpu")
    print(f"loaded Laya (english) in {time.perf_counter() - t0:.1f} s")

    base = base_scores(backend, rows, questions)
    base_ms = np.median([base[r["id"]]["ms"] for r in rows])
    t0 = time.perf_counter()
    backend.embed([r["text"] for r in rows])
    embed_ms = (time.perf_counter() - t0) * 1000 / len(rows)
    print(f"base Laya: median {base_ms:.0f} ms per review (4 questions); embedding: {embed_ms:.0f} ms per state\n")

    strategies = EMBEDDING_STRATEGIES + (["activation_steering"] if args.steering else [])
    results = {"protocol": {}, "timing_ms": {"base_review": base_ms, "embedding": embed_ms}}
    holdout_scores = {}
    hard_subset = np.array([not r["variant"].startswith("weaken-") or "with-fix" in r["variant"] for r in holdout])

    for question in QUESTIONS:
        spec = task_spec(question, questions[question])
        y = np.array([r["labels"][question] for r in holdout])
        tasks = [r["task"] for r in holdout]
        scores = {"base": np.array([base[r["id"]]["p"][question] for r in holdout])}
        rule = rule_scores(holdout, question)
        if rule is not None:
            scores["rule"] = rule
        for name in strategies:
            try:
                scores[name] = fit_predict(name, spec, dev, holdout, question, backend, np.random.default_rng(1))
            except Exception as error:  # noqa: BLE001 -- report and continue with the other strategies
                print(f"  {question} / {name}: {type(error).__name__}: {error}")
        holdout_scores[question] = scores

        print(f"== {question}  (holdout: {int(y.sum())} yes / {int(len(y) - y.sum())} no)")
        print(f"   {'method':30} {'AUC':>6} {'bal.acc':>8} {'Brier':>6}   AUC vs base [95% CI]")
        table = {}
        for name, s in scores.items():
            threshold_pred = (
                np.array([not HARNESS_FLAG[question](p) for p in s]) if question == "addresses_request" else
                np.array([HARNESS_FLAG[question](p) for p in s])
            ).astype(int) if name == "base" else (s >= 0.5).astype(int)
            row = {"auc": auc(s, y), "balanced_accuracy": balanced_accuracy(threshold_pred, y), "brier": brier(s, y)}
            if name != "base":
                row["auc_diff_ci"] = bootstrap_auc_diff(tasks, s, scores["base"], y)
            if question == "addresses_request":
                row["auc_code_changes"] = auc(s[hard_subset], y[hard_subset])
            table[name] = row
            ci = f"[{row['auc_diff_ci'][0]:+.2f}, {row['auc_diff_ci'][1]:+.2f}]" if "auc_diff_ci" in row else ""
            extra = f"   code-change subset AUC {row['auc_code_changes']:.2f}" if "auc_code_changes" in row else ""
            print(f"   {name:30} {row['auc']:6.2f} {row['balanced_accuracy']:8.2f} {row['brier']:6.3f}   {ci}{extra}")
        results["protocol"].setdefault("holdout", {})[question] = table

        readers = [s for s in EMBEDDING_STRATEGIES if s in scores]
        # Grouped CV over dev tasks only: picks the reader used in the revise decision below,
        # so holdout tasks never influence the choice.
        results["protocol"].setdefault("dev_cv", {})[question] = grouped_cv(
            dev, ["base", *readers], 4, spec, question, base, backend
        )
        # Grouped 5-fold CV over all tasks: robustness check of the holdout numbers.
        cv = grouped_cv(rows, ["base", *readers], 5, spec, question, base, backend)
        results["protocol"].setdefault("cv", {})[question] = cv
        print("   5-fold CV AUC (all tasks): " + ", ".join(f"{k} {v:.2f}" for k, v in cv.items()) + "\n")

    # The combined revise decision on holdout: harness policy on base Laya vs the best reader per question.
    should = np.array([r["should_revise"] for r in holdout])
    good = np.array([r["should_revise"] == 0 for r in holdout])

    def revise_metrics(flags):
        revise = flags.any(axis=1).astype(int)
        return {
            "revise_rate": float(revise.mean()),
            "recall": float(revise[should == 1].mean()),
            "false_revisions_on_good_work": float(revise[good].mean()),
            "balanced_accuracy": balanced_accuracy(revise, should),
        }

    base_flags = np.stack(
        [np.array([HARNESS_FLAG[q](p) for p in holdout_scores[q]["base"]]) for q in QUESTIONS], axis=1
    )
    best = {}
    for q in QUESTIONS:
        dev_cv = results["protocol"]["dev_cv"][q]
        candidates = {k: v for k, v in dev_cv.items() if k != "base"}
        best[q] = max(candidates, key=candidates.get)
    reader_flags = np.stack(
        [
            (holdout_scores[q][best[q]] < 0.5) if q == "addresses_request" else (holdout_scores[q][best[q]] >= 0.5)
            for q in QUESTIONS
        ],
        axis=1,
    )
    results["revise"] = {
        "base_with_harness_thresholds": revise_metrics(base_flags),
        "best_reader_per_question": {"choice": best, **revise_metrics(reader_flags)},
    }
    for q_index, q in enumerate(QUESTIONS):
        results["revise"].setdefault("flags_per_question", {})[q] = {
            "base": float(base_flags[:, q_index].mean()),
            "reader": float(reader_flags[:, q_index].mean()),
        }
    print("== revise decision on holdout (should revise:", int(should.sum()), "of", len(should), ")")
    for name, m in results["revise"].items():
        if name != "flags_per_question":
            print(f"   {name}: {json.dumps(m)}")

    (DATA / "results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"\nwrote {DATA / 'results.json'}")


if __name__ == "__main__":
    main()
