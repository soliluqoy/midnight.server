"""Fetch hash-locked SWE-bench Lite dev snapshots, without installing/executing them.

Requires Python 3.12+ and curl with a working system certificate store.
Output must be outside the checkout. Gold patches stay in evaluator metadata,
never in the extracted base trees. Not an official SWE-bench solve-rate runner.
"""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile


REPO = Path(__file__).resolve().parents[1]
HERE = REPO / "docs" / "premise"
METADATA_URL = (
    "https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Lite"
    "&config=default&split=dev&offset=0&length=100"
)
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_EXPANDED = 1024 * 1024 * 1024


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def download(url, target, expected):
    if target.exists():
        if digest(target) != expected:
            raise ValueError(f"Hash mismatch in cached file: {target}; will not overwrite it")
        return
    curl = shutil.which("curl.exe") or shutil.which("curl")
    if not curl:
        raise RuntimeError("curl is required; TLS verification must remain enabled")
    part = target.with_suffix(target.suffix + ".part")
    try:
        subprocess.run(
            [curl, "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
             "--proto-redir", "=https", "--max-time", "180", "--max-filesize", str(MAX_ARCHIVE),
             "--output", str(part), url],
            check=True, timeout=190,
        )
        if digest(part) != expected:
            raise ValueError(f"Hash mismatch for {url}; review upstream changes, do not silently relock")
        part.replace(target)
    finally:
        part.unlink(missing_ok=True)


def extract_snapshot(archive, destination):
    """Extract regular files only into a new tree; skip links and special files."""
    if destination.exists():
        raise ValueError(f"Refusing to reuse a possibly modified snapshot: {destination}")
    with tempfile.TemporaryDirectory(prefix="extract-", dir=destination.parent) as temporary:
        staging = Path(temporary) / "tree"
        staging.mkdir()
        total = 0
        roots = set()
        with tarfile.open(archive) as source:
            for member in source:
                path = PurePosixPath(member.name)
                if (path.is_absolute() or ".." in path.parts or "\\" in member.name
                        or ":" in member.name or not path.parts):
                    raise ValueError(f"Unsafe archive path: {member.name}")
                roots.add(path.parts[0])
                if len(roots) != 1:
                    raise ValueError("Expected one archive root")
                if not (member.isfile() or member.isdir()):
                    continue
                total += member.size
                if total > MAX_EXPANDED:
                    raise ValueError("Expanded archive exceeds the 1 GiB limit")
                if len(path.parts) == 1:
                    if not member.isdir():
                        raise ValueError("Archive root is not a directory")
                    continue
                # Strip GitHub's long commit-hash wrapper to reduce Windows path lengths.
                relative = PurePosixPath(*path.parts[1:]).as_posix()
                source.extract(member.replace(name=relative), staging, filter="data")
        if len(roots) != 1:
            raise ValueError("Empty archive")
        staging.rename(destination)


def main():
    if sys.version_info < (3, 12):
        raise RuntimeError("Python 3.12+ is required for safe tar extraction")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    root = args.out.resolve()
    if root == REPO or REPO in root.parents:
        raise ValueError("Snapshots and answer-bearing metadata must stay outside the project checkout")
    root.mkdir(parents=True, exist_ok=True)
    lock = json.loads((HERE / "dataset.lock.json").read_text(encoding="utf8"))
    metadata = root / "swe-lite-dev.json"
    download(METADATA_URL, metadata, lock["metadataSha256"])
    rows = json.loads(metadata.read_text(encoding="utf8"))["rows"]
    by_id = {item["row"]["instance_id"]: item["row"] for item in rows}
    if len(by_id) != len(rows) or set(by_id) != {task["id"] for task in lock["tasks"]}:
        raise ValueError("Dataset membership changed")
    tasks = []
    for item in lock["tasks"]:
        row = by_id[item["id"]]
        if row["base_commit"] != item["baseCommit"] or row["repo"] != item["repo"]:
            raise ValueError("Dataset revision changed")
        if (not re.fullmatch(r"[0-9a-f]{40}", row["base_commit"])
                or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", row["repo"])
                or not re.fullmatch(r"[A-Za-z0-9_.-]+", item["id"])):
            raise ValueError("Invalid source identifier")
        url = f"https://codeload.github.com/{row['repo']}/tar.gz/{row['base_commit']}"
        archive = root / (item["id"] + ".tar.gz")
        download(url, archive, item["archiveSha256"])
        destination = root / item["id"]
        extract_snapshot(archive, destination)
        tasks.append({**item, "root": str(destination), "request": row["problem_statement"],
                      "goldPaths": sorted(set(re.findall(r"^diff --git a/.* b/(.*)$", row["patch"], re.M)))})
        print(item["id"], flush=True)
    manifest = {"schemaVersion": 1, "dataset": lock["dataset"], "split": "dev",
                "metadataSha256": lock["metadataSha256"], "tasks": tasks}
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf8")


if __name__ == "__main__":
    main()
