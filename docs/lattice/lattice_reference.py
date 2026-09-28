#!/usr/bin/env python3
"""Lattice reference: bounded optimization of a pure record-filtering harness.

Python 3.10+; standard library only. This is a closed DSL, not an OS sandbox.
Candidate programs are permutations of five fixed, pure predicates.
"""
import argparse
import hashlib
import itertools
import json
import math
import random
import sqlite3
import statistics
import sys
import time
from pathlib import Path

OPS = ("text_hit", "size_positive", "visible", "is_log", "old_enough")
BASELINE = OPS
MAX_RECORDS = 4096
MAX_TEXT = 256
FUEL = MAX_RECORDS * (MAX_TEXT + 4)
SCHEMA = """
CREATE TABLE IF NOT EXISTS versions (
 id INTEGER PRIMARY KEY, parent INTEGER REFERENCES versions(id),
 program TEXT NOT NULL, digest TEXT NOT NULL, report TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS head (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 version INTEGER NOT NULL REFERENCES versions(id));
CREATE TABLE IF NOT EXISTS audit (
 id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
 previous TEXT NOT NULL, digest TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS releases (
 release_id TEXT PRIMARY KEY, report TEXT NOT NULL);
"""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def checked_program(value):
    if not isinstance(value, (tuple, list)):
        raise ValueError("program must be an array")
    if len(value) != len(OPS) or any(type(x) is not str for x in value):
        raise ValueError("program has wrong shape")
    if set(value) != set(OPS):
        raise ValueError("every fixed predicate must occur exactly once")
    return tuple(value)


def checked_records(rows):
    if type(rows) is not list or len(rows) > MAX_RECORDS:
        raise ValueError("input must be a bounded array")
    keys = {"id", "text", "size", "hidden", "ext", "age"}
    ids = set()
    for row in rows:
        if type(row) is not dict or set(row) != keys:
            raise ValueError("invalid record schema")
        if type(row["id"]) is not int or row["id"] in ids:
            raise ValueError("record IDs must be unique integers")
        ids.add(row["id"])
        if type(row["text"]) is not str or len(row["text"]) > MAX_TEXT:
            raise ValueError("text length exceeded")
        if type(row["ext"]) is not str or len(row["ext"]) > 16:
            raise ValueError("invalid extension")
        if type(row["hidden"]) is not bool:
            raise ValueError("hidden must be boolean")
        if any(type(row[k]) is not int or abs(row[k]) > 10**9
               for k in ("size", "age")):
            raise ValueError("size and age must be bounded integers")
    return rows


def primitive(name, row):
    # Units are a declared virtual cost, not CPU cycles or actual comparisons.
    if name == "text_hit":
        return "ERROR" in row["text"], max(1, len(row["text"]))
    if name == "size_positive":
        return row["size"] > 0, 1
    if name == "visible":
        return not row["hidden"], 1
    if name == "is_log":
        return row["ext"] == "log", 1
    if name == "old_enough":
        return row["age"] >= 14, 1
    raise ValueError("unknown primitive")


def oracle(rows):
    # Fixed semantic contract, independent of the candidate's execution order.
    return [r["id"] for r in rows if
            r["size"] > 0 and not r["hidden"] and r["ext"] == "log"
            and r["age"] >= 14 and "ERROR" in r["text"]]


def execute(program, rows, fuel=FUEL):
    program = checked_program(program)
    output, units, calls = [], 0, 0
    for row in rows:
        keep = True
        for op in program:
            passed, charge = primitive(op, row)
            units += charge
            calls += 1
            if units > fuel:
                raise RuntimeError("virtual fuel exhausted")
            if not passed:
                keep = False
                break
        if keep:
            output.append(row["id"])
    return output, units, calls


def fixture(seed, count=256, log_probability=0.2):
    rng = random.Random(seed)
    rows = []
    for index in range(count):
        text = "x" * rng.randint(16, 120)
        if rng.random() < 0.6:
            text += "ERROR"
        rows.append({
            "id": index, "text": text,
            "size": rng.choice([0, 1, 10, 100]),
            "hidden": rng.random() < 0.15,
            "ext": "log" if rng.random() < log_probability else "txt",
            "age": rng.randrange(40),
        })
    return checked_records(rows)


def boundary_fixture():
    rows = []
    for i, values in enumerate(itertools.product(
            ("", "ERROR", "error"), (0, 1), (False, True),
            ("log", "LOG"), (13, 14))):
        text, size, hidden, ext, age = values
        rows.append(dict(id=i, text=text, size=size, hidden=hidden, ext=ext, age=age))
    return checked_records(rows)


def evaluate(program, batches):
    costs = []
    for rows in batches:
        output, units, _ = execute(program, rows)
        if output != oracle(rows):
            raise RuntimeError("semantic mismatch")
        costs.append(units)
    return costs


def lower_bound_gains(parent_costs, child_costs, seed=8128):
    gains = [(a-b)/max(a, 1) for a, b in zip(parent_costs, child_costs)]
    rng = random.Random(seed)
    means = sorted(statistics.mean(rng.choices(gains, k=len(gains)))
                   for _ in range(2000))
    # Fixed-sample, one-sided 99% percentile-bootstrap bound, approximate.
    return statistics.mean(gains), means[19]


def log_audit(db, kind, payload):
    prior = db.execute("SELECT digest FROM audit ORDER BY id DESC LIMIT 1").fetchone()
    previous = prior[0] if prior else "0" * 64
    serialized = canonical(payload)
    checksum = digest([previous, kind, serialized])
    db.execute("INSERT INTO audit(kind,payload,previous,digest) VALUES(?,?,?,?)",
               (kind, serialized, previous, checksum))


def verify_store(db):
    previous = "0" * 64
    for _, kind, payload, recorded_previous, checksum in db.execute(
            "SELECT * FROM audit ORDER BY id"):
        if recorded_previous != previous or digest([previous, kind, payload]) != checksum:
            raise RuntimeError("audit corruption")
        previous = checksum
    for _, _, program, checksum, _ in db.execute("SELECT * FROM versions"):
        parsed = checked_program(json.loads(program))
        if digest(parsed) != checksum:
            raise RuntimeError("version corruption")
    row = db.execute("SELECT version FROM head WHERE singleton=1").fetchone()
    if row and not db.execute("SELECT 1 FROM versions WHERE id=?", row).fetchone():
        raise RuntimeError("invalid head")


def open_store(path):
    db = sqlite3.connect(path, timeout=5)
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    db.executescript(SCHEMA)
    verify_store(db)
    with db:
        if not db.execute("SELECT 1 FROM head").fetchone():
            cur = db.execute(
                "INSERT INTO versions(parent,program,digest,report) VALUES(NULL,?,?,?)",
                (canonical(BASELINE), digest(BASELINE), canonical({"kind": "seed"})))
            db.execute("INSERT INTO head VALUES(1,?)", (cur.lastrowid,))
            log_audit(db, "initialize", {"version": cur.lastrowid})
    return db


def active(db):
    row = db.execute(
        "SELECT v.id,v.parent,v.program FROM versions v JOIN head h ON h.version=v.id"
    ).fetchone()
    return row[0], row[1], checked_program(json.loads(row[2]))


def hill_search(parent, batches, cap=80):
    champion = parent
    champion_cost = sum(evaluate(parent, batches))
    seen = {parent}
    evaluations = 1
    while evaluations < cap:
        candidates = []
        for i in range(len(OPS)-1):
            child = list(champion)
            child[i], child[i+1] = child[i+1], child[i]
            child = tuple(child)
            if child not in seen:
                candidates.append(child)
        if not candidates:
            break
        best, best_cost = champion, champion_cost
        for child in candidates:
            if evaluations >= cap:
                break
            seen.add(child)
            cost = sum(evaluate(child, batches))
            evaluations += 1
            if cost < best_cost:
                best, best_cost = child, cost
        if best_cost >= champion_cost:
            break
        champion, champion_cost = best, best_cost
    return champion, evaluations


def simple_baseline(batches):
    # Ordinary cost/selectivity baseline; learned only from development rows.
    rows = [row for batch in batches for row in batch]
    scores = []
    for op in OPS:
        results = [primitive(op, r) for r in rows]
        rejection_rate = sum(not ok for ok, _ in results) / len(rows)
        mean_cost = statistics.mean(cost for _, cost in results)
        scores.append((mean_cost / max(rejection_rate, 1e-9), op))
    return tuple(op for _, op in sorted(scores))


def learn(db):
    release_id = "synthetic-release-001"
    if db.execute("SELECT 1 FROM releases WHERE release_id=?", (release_id,)).fetchone():
        raise RuntimeError("release already consumed; use fresh data for another campaign")
    parent_id, _, parent = active(db)
    start = time.perf_counter()
    development = [fixture(i) for i in range(16)]
    candidate, evaluations = hill_search(parent, development)
    # Freeze before constructing or reading release batches.
    candidate_hash = digest(candidate)
    conventional = simple_baseline(development)
    boundary = boundary_fixture()
    evaluate(parent, [boundary])
    evaluate(candidate, [boundary])
    release = [fixture(10000+i) for i in range(32)]
    parent_costs = evaluate(parent, release)
    child_costs = evaluate(candidate, release)
    mean_gain, lower = lower_bound_gains(parent_costs, child_costs)
    shifted = [fixture(20000+i, log_probability=0.8) for i in range(8)]
    shift_parent = sum(evaluate(parent, shifted))
    shift_child = sum(evaluate(candidate, shifted))
    passed = candidate != parent and lower >= 0.05 and shift_child <= shift_parent
    report = {
        "release_id": release_id, "parent_version": parent_id,
        "candidate": candidate, "candidate_digest": candidate_hash,
        "development_evaluations": evaluations,
        "release_batches": len(release),
        "mean_virtual_cost_reduction": mean_gain,
        "approximate_99pct_lower_bound": lower,
        "parent_virtual_units": sum(parent_costs),
        "candidate_virtual_units": sum(child_costs),
        "conventional_order": conventional,
        "conventional_virtual_units": sum(evaluate(conventional, release)),
        "shifted_cost_ratio": shift_child/max(shift_parent, 1),
        "wall_seconds_entire_campaign": time.perf_counter()-start,
        "accepted": passed,
        "limits": "synthetic data; modeled cost; no OS sandbox; no meta-learning",
    }
    # At most one writer promotes, with a compare-and-swap head precondition.
    try:
        db.execute("BEGIN IMMEDIATE")
        if active(db)[0] != parent_id:
            raise RuntimeError("active version changed; campaign is stale")
        db.execute("INSERT INTO releases VALUES(?,?)", (release_id, canonical(report)))
        log_audit(db, "release_evaluation", report)
        if passed:
            cur = db.execute(
                "INSERT INTO versions(parent,program,digest,report) VALUES(?,?,?,?)",
                (parent_id, canonical(candidate), candidate_hash, canonical(report)))
            db.execute("UPDATE head SET version=? WHERE singleton=1", (cur.lastrowid,))
            log_audit(db, "promote", {"from": parent_id, "to": cur.lastrowid})
        db.commit()
    except Exception:
        db.rollback()
        raise
    return report


def rollback(db):
    try:
        db.execute("BEGIN IMMEDIATE")
        current, parent, _ = active(db)
        if parent is None:
            raise RuntimeError("seed version has no parent")
        db.execute("UPDATE head SET version=? WHERE singleton=1", (parent,))
        log_audit(db, "rollback", {"from": current, "to": parent})
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"active_version": parent}


def selftest():
    edge = boundary_fixture()
    expected = oracle(edge)
    for order in itertools.permutations(OPS):
        if execute(order, edge)[0] != expected:
            raise AssertionError("permutation equivalence failed")
    for invalid in [OPS[:-1], OPS + ("visible",), ["arbitrary_code"] * 5]:
        try:
            checked_program(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError("invalid program accepted")
    try:
        execute(OPS, edge, fuel=0)
    except RuntimeError:
        pass
    else:
        raise AssertionError("fuel was ignored")
    db = open_store(":memory:")
    initial = active(db)[0]
    result = learn(db)
    if not result["accepted"] or active(db)[0] == initial:
        raise AssertionError("expected fixture improvement not promoted")
    try:
        learn(db)
    except RuntimeError:
        pass
    else:
        raise AssertionError("release was reused")
    rollback(db)
    if active(db)[0] != initial:
        raise AssertionError("rollback failed")
    verify_store(db)
    db.execute("UPDATE audit SET payload='{}' WHERE id=1")
    try:
        verify_store(db)
    except RuntimeError:
        pass
    else:
        raise AssertionError("corruption was missed")
    db.close()
    return {"selftest": "passed", "permutations_checked": math.factorial(len(OPS))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="lattice.db")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("init", "status", "learn", "rollback", "selftest"):
        sub.add_parser(name)
    run = sub.add_parser("run")
    run.add_argument("input", type=Path)
    args = parser.parse_args()
    if args.command == "selftest":
        print(json.dumps(selftest(), indent=2))
        return
    db = open_store(args.db)
    try:
        if args.command == "learn":
            result = learn(db)
        elif args.command == "rollback":
            result = rollback(db)
        elif args.command == "run":
            if args.input.stat().st_size > 4 * 1024 * 1024:
                raise ValueError("input exceeds 4 MiB")
            # CLI inputs are trusted local files; stat/read is not a hostile-file boundary.
            rows = checked_records(json.loads(args.input.read_text(encoding="utf-8")))
            version, _, program = active(db)
            output, units, calls = execute(program, rows)
            result = dict(version=version, matching_ids=output,
                          virtual_units=units, primitive_calls=calls)
        else:
            version, parent, program = active(db)
            result = dict(active_version=version, parent=parent, program=program)
        print(json.dumps(result, indent=2))
    finally:
        db.close()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, sqlite3.Error) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
