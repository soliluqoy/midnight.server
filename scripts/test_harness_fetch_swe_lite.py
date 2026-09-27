import hashlib
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

from harness_fetch_swe_lite import download, extract_snapshot


class SnapshotSafetyTests(unittest.TestCase):
    def archive(self, root, entries):
        archive = root / "fixture.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            for name, kind, body in entries:
                info = tarfile.TarInfo(name)
                info.type = kind
                if kind == tarfile.REGTYPE:
                    info.size = len(body)
                    output.addfile(info, io.BytesIO(body))
                else:
                    info.linkname = "../../outside"
                    output.addfile(info)
        return archive

    def test_extracts_regular_files_but_not_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = self.archive(root, [
                ("snapshot/source.py", tarfile.REGTYPE, b"x = 1\n"),
                ("snapshot/link", tarfile.SYMTYPE, b""),
                ("snapshot/hard", tarfile.LNKTYPE, b""),
            ])
            extract_snapshot(archive, root / "tree")
            self.assertEqual((root / "tree/source.py").read_bytes(), b"x = 1\n")
            self.assertFalse((root / "tree/link").exists())
            self.assertFalse((root / "tree/hard").exists())

    def test_rejects_unsafe_paths_and_preserves_other_files(self):
        for name in ["../outside", "/outside", "snapshot/../../outside", "C:/outside", "snapshot\\outside"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                archive = self.archive(root, [(name, tarfile.REGTYPE, b"untrusted")])
                with self.assertRaises(ValueError):
                    extract_snapshot(archive, root / "tree")
                self.assertFalse((root / "tree").exists())

    def test_rejects_multiple_roots_and_existing_trees(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = self.archive(root, [("one/a", tarfile.REGTYPE, b"a"), ("two/b", tarfile.REGTYPE, b"b")])
            with self.assertRaises(ValueError):
                extract_snapshot(archive, root / "tree")
            (root / "tree").mkdir()
            (root / "tree/keep").write_text("keep", encoding="utf8")
            with self.assertRaises(ValueError):
                extract_snapshot(archive, root / "tree")
            self.assertEqual((root / "tree/keep").read_text(encoding="utf8"), "keep")

    def test_cached_download_must_match_lock_without_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "cached"
            target.write_bytes(b"fixture")
            download("https://invalid.example/never-used", target, hashlib.sha256(b"fixture").hexdigest())
            with self.assertRaises(ValueError):
                download("https://invalid.example/never-used", target, "0" * 64)
            self.assertEqual(target.read_bytes(), b"fixture")


if __name__ == "__main__":
    unittest.main()
