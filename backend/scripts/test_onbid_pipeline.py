"""Offline cycle checks: safe raw reuse, atomic latest-success, and aggregate reports."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from xml.etree import ElementTree

from onbid_pipeline import bar_svg, copy_verified_raw, histogram, run_cycle, safe_label


class CycleTest(unittest.TestCase):
    def test_reuse_checks_hash_and_rejects_outside_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            (source / "raw").mkdir(parents=True)
            raw = b'{"fixture": true}'
            (source / "raw/page.json").write_bytes(raw)
            manifest = {"complete": True, "pages": [{
                "path": "raw/page.json", "sha256": hashlib.sha256(raw).hexdigest()
            }]}
            (source / "manifest.json").write_text(json.dumps(manifest))
            copy_verified_raw(source, root / "copied")
            self.assertEqual((root / "copied/raw/page.json").read_bytes(), raw)
            (source / "raw/page.json").write_bytes(b"corrupt")
            with self.assertRaises(ValueError):
                copy_verified_raw(source, root / "bad-checksum")
            manifest["pages"][0]["path"] = "../private.json"
            (source / "manifest.json").write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                copy_verified_raw(source, root / "bad-path")

    def test_failed_run_keeps_latest_success_and_preserves_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous = {"run_id": "previous-success", "status": "completed"}
            (root / "latest.json").write_text(json.dumps(previous))
            with patch("onbid_pipeline.copy_verified_raw", side_effect=ValueError("fixture")):
                with self.assertRaises(ValueError):
                    run_cycle(root, reuse_run=root / "missing", n_estimators=3)
            self.assertEqual(json.loads((root / "latest.json").read_text()), previous)
            attempt = json.loads((root / "latest-attempt.json").read_text())
            self.assertEqual(attempt["status"], "failed")
            manifest = json.loads((root / "runs" / attempt["run_id"] / "manifest.json").read_text())
            self.assertEqual(manifest["stages"][0]["status"], "failed")
            self.assertFalse((root / ".cycle.lock").exists())
            self.assertEqual(len((root / "history.jsonl").read_text().splitlines()), 1)

    def test_request_budget_cannot_exceed_one_hundred(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                run_cycle(Path(directory), reuse_run=Path(directory), max_calls=101)

    def test_chart_escapes_labels_and_keeps_all_histogram_rows(self):
        rows = histogram([0, 50, 100, 101, 100000], [50, 100], ["low", "middle", "high"])
        self.assertEqual(sum(row["count"] for row in rows), 5)
        self.assertEqual([row["count"] for row in rows], [1, 1, 3])
        rendered = bar_svg("<script>unsafe</script>", [{"label": "<script>", "count": 10}])
        ElementTree.fromstring(rendered)
        self.assertNotIn("<script>", rendered)
        self.assertNotIn("123가4567", safe_label("차량 123가4567"))


if __name__ == "__main__":
    unittest.main()
