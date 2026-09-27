import math
import random
import unittest

from harness_lab import (analyze, boolean_metrics, contrasts, exact_policy_cost,
                         full_cube_clusters, success, synthetic_rows,
                         validate_math, walsh)


class NumericalChecks(unittest.TestCase):
    def test_transform_against_direct_definition_and_inverse(self):
        rng = random.Random(8)
        values = [rng.uniform(-2, 2) for _ in range(16)]
        got = walsh(values)
        direct = [sum(v * (-1) ** ((s & x).bit_count())
                      for x, v in enumerate(values)) / 16 for s in range(16)]
        for a, b in zip(got, direct):
            self.assertAlmostEqual(a, b)
        for a, b in zip(values, walsh(got)):
            self.assertAlmostEqual(a, 16 * b)

    def test_all_three_bit_functions_and_signed_matrix(self):
        self.assertEqual(validate_math()["boolean_functions_checked"], 256)

    def test_local_zero_does_not_imply_no_dependency(self):
        a = boolean_metrics([0] * 15 + [1])
        self.assertEqual(a["local_sensitivity"][0], 0)
        self.assertEqual(a["degree"], 4)

    def test_known_block_sensitivity_witness(self):
        # OR of two AND pairs: no single flip at zero matters; two disjoint pairs do.
        values = [int((x & 3) == 3 or (x & 12) == 12) for x in range(16)]
        self.assertEqual(boolean_metrics(values)["local_sensitivity"][0], 0)
        self.assertGreaterEqual(boolean_metrics(values)["max_block_sensitivity"], 2)

    def test_cost_optimal_query_order(self):
        r = exact_policy_cost([0, 0, 0, 1], [1, 10])
        self.assertEqual(r["first_query_index"], 0)
        self.assertEqual(r["expected_cost"], 6)

    def test_factorial_contrast_signs(self):
        result = contrasts([.30, .32, .31, .70], ["A", "B"])
        self.assertAlmostEqual(result["interaction:A:B"], .37)
        self.assertAlmostEqual(result["main:A"], .205)
        self.assertAlmostEqual(result["main:B"], .195)
        self.assertAlmostEqual(result["all_on_minus_all_off"], .40)

    def test_timeout_never_counts_as_completion_success(self):
        row = {"artifact_passed": True, "completed": True,
               "timed_out": True, "over_budget": False}
        self.assertEqual(success(row), 0)
        del row["over_budget"]
        with self.assertRaises(ValueError):
            success(row)

    def test_rejects_missing_and_duplicate_records(self):
        rows = synthetic_rows(task_count=3, repeats=2)
        factors = ["contextPack", "inRunChecks"]
        with self.assertRaises(ValueError):
            full_cube_clusters(rows[:-1], factors)
        with self.assertRaises(ValueError):
            full_cube_clusters(rows + [rows[0]], factors)

    def test_cluster_equal_weight_not_run_weight(self):
        rows = synthetic_rows(task_count=3, repeats=2)
        for row in rows:
            first = row["task_id"] == "task-0"
            row["cluster_id"] = "cluster-a" if first else "cluster-b"
            row["artifact_passed"] = first
        result = analyze(rows, ["contextPack", "inRunChecks"], resamples=100)
        self.assertEqual(result["clusters"], 2)
        self.assertEqual(result["cube_success_rates"], [.5] * 4)


if __name__ == "__main__":
    unittest.main()
