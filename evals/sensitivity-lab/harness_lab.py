"""Offline numerical laboratory. Python 3.10+, standard library only.

Synthetic mode demonstrates methods, not midnight.server performance.
Analyze mode accepts normalized, complete factorial experiment records.
Bit i is factor_names[i]. Fourier basis is x_i = (-1)**bit_i.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from functools import lru_cache
from itertools import combinations
import json
import math
from pathlib import Path
import random
from statistics import mean


def dimension(values):
    n = len(values)
    if n < 2 or n & (n - 1):
        raise ValueError("Expected a full cube with 2**k entries, k >= 1")
    return n.bit_length() - 1


def walsh(values):
    """Normalized fast Walsh-Hadamard transform, O(k * 2**k)."""
    dimension(values)
    a = list(map(float, values))
    h = 1
    while h < len(a):
        for base in range(0, len(a), 2 * h):
            for j in range(base, base + h):
                u, v = a[j], a[j + h]
                a[j], a[j + h] = u + v, u - v
        h *= 2
    return [x / len(a) for x in a]


def boolean_metrics(values):
    k = dimension(values)
    if any(type(v) is not int or v not in (0, 1) for v in values):
        raise ValueError("Exact Boolean metrics require an integer 0/1 truth table")
    local = [sum(values[x] != values[x ^ (1 << i)] for i in range(k))
             for x in range(1 << k)]
    coefficients = walsh([2 * v - 1 for v in values])
    degree = max((s.bit_count() for s, c in enumerate(coefficients)
                  if abs(c) > 1e-12), default=0)
    block = []
    for x in range(1 << k):
        sensitive = [b for b in range(1, 1 << k) if values[x] != values[x ^ b]]
        best = {0: 0}
        for b in sensitive:
            for used, count in list(best.items()):
                if not used & b:
                    union = used | b
                    best[union] = max(best.get(union, 0), count + 1)
        block.append(max(best.values()))
    return {"dimension": k, "local_sensitivity": local,
            "max_sensitivity": max(local), "degree": degree,
            "max_block_sensitivity": max(block),
            "total_influence_edges": mean(local),
            "total_influence_fourier": sum(s.bit_count() * c * c
                                            for s, c in enumerate(coefficients)),
            "coefficients": coefficients}


def signed_cube(k):
    if k < 1 or k > 6:
        raise ValueError("Signed-matrix demonstration limited to 1..6 dimensions")
    a = [[0, 1], [1, 0]]
    for _ in range(2, k + 1):
        n = len(a)
        a = [[(a[i][j] if i < n and j < n else
               -a[i - n][j - n] if i >= n and j >= n else
               int(i % n == j % n)) for j in range(2 * n)]
             for i in range(2 * n)]
    return a


def exact_policy_cost(values, costs):
    """Minimum expected query cost for an exact policy, independent uniform bits.

    Queries are assumed side-effect free and predicates exact. This does not
    validate the observations that a real classifier supplies to the policy.
    """
    k = dimension(values)
    if len(costs) != k or any(c <= 0 for c in costs):
        raise ValueError("One positive cost per bit required")

    @lru_cache(None)
    def solve(known, observed):
        remaining = {values[x] for x in range(1 << k) if x & known == observed}
        if len(remaining) == 1:
            return 0.0, None
        candidates = []
        for i in range(k):
            b = 1 << i
            if not known & b:
                zero, _ = solve(known | b, observed)
                one, _ = solve(known | b, observed | b)
                candidates.append((costs[i] + (zero + one) / 2, i))
        return min(candidates)

    expected, first = solve(0, 0)
    return {"expected_cost": expected, "first_query_index": first,
            "evaluate_all_cost": sum(costs), "prior": "independent uniform bits"}


def success(row):
    for key in ("artifact_passed", "completed", "timed_out", "over_budget"):
        if type(row.get(key)) is not bool:
            raise ValueError(f"Missing explicit Boolean {key}")
    return int(row["artifact_passed"] and row["completed"]
               and not row["timed_out"] and not row["over_budget"])


def full_cube_clusters(rows, factor_names):
    """Equal clusters, equal tasks within cluster, equal cells within task."""
    k = len(factor_names)
    if not 1 <= k <= 8 or len(set(factor_names)) != k:
        raise ValueError("Require 1..8 distinct factors")
    cells = defaultdict(lambda: defaultdict(dict))
    seen = set()
    task_cluster = {}
    for row in rows:
        run_id = row["run_id"]
        if run_id in seen:
            raise ValueError(f"Duplicate run_id {run_id}")
        seen.add(run_id)
        task, cluster = row["task_id"], row["cluster_id"]
        if task in task_cluster and task_cluster[task] != cluster:
            raise ValueError("Task belongs to multiple clusters")
        task_cluster[task] = cluster
        factors = row["factors"]
        if set(factors) != set(factor_names):
            raise ValueError("Resolved factors do not match manifest")
        if any(type(factors[f]) is not bool for f in factor_names):
            raise ValueError("Factors must be Boolean")
        mask = sum(int(factors[f]) << i for i, f in enumerate(factor_names))
        repeat = row["repeat"]
        if type(repeat) is not int or repeat < 0:
            raise ValueError("repeat must be a nonnegative integer")
        cell = cells[task][mask]
        if repeat in cell:
            raise ValueError("Duplicate task/configuration/repeat")
        cell[repeat] = success(row)
    if not cells:
        raise ValueError("No records")
    groups = defaultdict(list)
    for task, table in cells.items():
        if set(table) != set(range(1 << k)):
            raise ValueError(f"Incomplete factorial block for task {task}; do not silently drop it")
        repeat_sets = [set(table[x]) for x in range(1 << k)]
        if any(s != repeat_sets[0] for s in repeat_sets):
            raise ValueError(f"Unbalanced repeats for task {task}")
        groups[task_cluster[task]].append([mean(table[x].values()) for x in range(1 << k)])
    return [[mean(t[x] for t in tables) for x in range(1 << k)]
            for _, tables in sorted(groups.items())]


def contrasts(table, factor_names):
    k = dimension(table)
    out = {"all_on_minus_all_off": table[-1] - table[0]}
    for i, name in enumerate(factor_names):
        bit = 1 << i
        out[f"main:{name}"] = mean(table[x | bit] - table[x]
                                  for x in range(1 << k) if not x & bit)
    for i, j in combinations(range(k), 2):
        a, b = 1 << i, 1 << j
        out[f"interaction:{factor_names[i]}:{factor_names[j]}"] = mean(
            table[x | a | b] - table[x | a] - table[x | b] + table[x]
            for x in range(1 << k) if not x & (a | b))
    return out


def quantile(values, q):
    a = sorted(values)
    position = q * (len(a) - 1)
    low, high = math.floor(position), math.ceil(position)
    return a[low] + (a[high] - a[low]) * (position - low)


def analyze(rows, factor_names, resamples=2000, seed=17):
    if resamples < 100:
        raise ValueError("Use at least 100 bootstrap resamples")
    groups = full_cube_clusters(rows, factor_names)
    if len(groups) < 2:
        raise ValueError("Need at least two independent clusters for interval estimation")
    n, size = len(groups), len(groups[0])
    table = [mean(g[x] for g in groups) for x in range(size)]
    point = contrasts(table, factor_names)
    rng = random.Random(seed)
    samples = {name: [] for name in point}
    for _ in range(resamples):
        sampled = [groups[rng.randrange(n)] for _ in range(n)]
        t = [mean(g[x] for g in sampled) for x in range(size)]
        for name, value in contrasts(t, factor_names).items():
            samples[name].append(value)
    return {"status": "EXPLORATORY_ANALYSIS", "clusters": n,
            "factor_order": factor_names, "cube_success_rates": table,
            "estimand": "equal cluster weight; equal tasks within each cluster",
            "contrasts": {name: {"estimate": value,
                          "pointwise_95pct_cluster_bootstrap":
                          [quantile(samples[name], .025), quantile(samples[name], .975)]}
                          for name, value in point.items()},
            "walsh_coefficients_of_estimated_rates": walsh(table),
            "warnings": ["Intervals are pointwise, not simultaneous or valid for repeated peeking.",
                         "Do not report Boolean degree/sensitivity from stochastic pass rates.",
                         "A selected winning configuration requires fresh confirmation."]
                        + (["Fewer than 20 clusters: uncertainty estimates can be unstable."] if n < 20 else [])}


def synthetic_rows(seed=41, task_count=80, repeats=12):
    """Planted interaction; intentionally not a benchmark of any real model."""
    rng = random.Random(seed)
    rows = []
    base = [.30, .32, .31, .70]  # mask order: neither, packet, feedback, both
    for task in range(task_count):
        offset = rng.uniform(-.10, .10)
        for repeat in range(repeats):
            order = list(range(4))
            rng.shuffle(order)
            for mask in order:
                rows.append({"run_id": f"synthetic-{task}-{repeat}-{mask}",
                             "task_id": f"task-{task}", "cluster_id": f"task-{task}",
                             "repeat": repeat, "factors": {
                                 "contextPack": bool(mask & 1),
                                 "inRunChecks": bool(mask & 2)},
                             "artifact_passed": rng.random() < base[mask] + offset,
                             "completed": True, "timed_out": False, "over_budget": False})
    return rows


def validate_math():
    checked = 0
    for encoding in range(1 << 8):
        table = [(encoding >> x) & 1 for x in range(8)]
        m = boolean_metrics(table)
        if m["degree"] > m["max_sensitivity"] ** 2:
            raise AssertionError("Degree bound failed")
        if m["max_block_sensitivity"] > m["max_sensitivity"] ** 4:
            raise AssertionError("Block bound failed")
        if not math.isclose(m["total_influence_edges"], m["total_influence_fourier"]):
            raise AssertionError("Independent edge/Fourier influence computations disagree")
        checked += 1
    for k in range(1, 6):
        a = signed_cube(k)
        n = len(a)
        for i in range(n):
            for j in range(n):
                if sum(a[i][t] * a[t][j] for t in range(n)) != (k if i == j else 0):
                    raise AssertionError("A_k squared is not kI")
                if bool(a[i][j]) != ((i ^ j).bit_count() == 1):
                    raise AssertionError("Support is not the hypercube")
    return {"boolean_functions_checked": checked, "dimensions": 3,
            "signed_matrix_dimensions_checked": [1, 2, 3, 4, 5],
            "meaning": "Finite numerical verification, not a proof for arbitrary dimension"}


def demo(out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = synthetic_rows()
    factors = ["contextPack", "inRunChecks"]
    report = {"status": "SYNTHETIC_DEMONSTRATION_ONLY", "math_checks": validate_math(),
              "and_example": boolean_metrics([0, 0, 0, 1]),
              "or_example": boolean_metrics([0, 1, 1, 1]),
              "exact_policy_query_example": exact_policy_cost([0, 0, 0, 1], [1, 10]),
              "planted_rates_mask_order": [.30, .32, .31, .70],
              "planted_interaction": .37,
              "observed_synthetic": analyze(rows, factors)}
    rng = random.Random(73)
    pairs = [(rng.random() < .5, rng.random() < .5) for _ in range(20000)]
    report["unchanged_condition_noise_control"] = {
        "expected_disagreement": .5,
        "observed_disagreement": mean(a != b for a, b in pairs),
        "known_causal_effect": 0}
    (out_dir / "synthetic-runs.jsonl").write_text(
        "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    (out_dir / "synthetic-manifest.json").write_text(json.dumps({"factors": factors}, indent=2), encoding="utf-8")
    (out_dir / "demo-results.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    d = sub.add_parser("demo")
    d.add_argument("--out", type=Path, default=Path("out"))
    a = sub.add_parser("analyze")
    a.add_argument("--runs", type=Path, required=True)
    a.add_argument("--manifest", type=Path, required=True)
    a.add_argument("--out", type=Path, required=True)
    a.add_argument("--resamples", type=int, default=2000)
    args = parser.parse_args()
    if args.command == "demo":
        demo(args.out)
    else:
        rows = [json.loads(line) for line in args.runs.read_text(encoding="utf-8").splitlines() if line.strip()]
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        result = analyze(rows, manifest["factors"], args.resamples)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(f"Wrote exploratory analysis to {args.out}")


if __name__ == "__main__":
    main()
