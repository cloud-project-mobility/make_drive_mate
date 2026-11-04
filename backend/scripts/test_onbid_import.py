"""Offline export import, provenance, privacy and clean-data contract regressions."""
import csv
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from onbid_data import DataError, ENDPOINT, decode_export, import_exports, normalize_record, parse_export, preprocess
from test_onbid_data import award


def export(rows, **changes):
    metadata = {"endpoint": ENDPOINT, "count": len(rows), "totalCount": len(rows),
                "params": {"opbdDtStart": "20260101", "opbdDtEnd": "20261103"},
                "collected_at": "2026-11-04 16:11 KST"}
    metadata.update(changes)
    return {"meta": metadata, "items": rows}


class ExportTests(unittest.TestCase):
    def test_json_duplicate_keys_and_non_finite_values_are_rejected(self):
        for raw in (b'{"meta": {}, "meta": {}, "items": []}', b'{"value": NaN}', b'not-json'):
            with self.subTest(raw=raw), self.assertRaises(DataError):
                decode_export(raw)

    def test_format_and_metadata_fail_closed(self):
        for payload in ({}, {"meta": {}, "items": {}}, export([], count=True),
                        export([], totalCount=1), export([], endpoint=ENDPOINT + "?serviceKey=x"),
                        export([], collected_at="2026-11-04T16:11"),
                        export([], params={"opbdDtStart": "20260230", "opbdDtEnd": "20261103"}),
                        export([], params={"opbdDtStart": "20261103", "opbdDtEnd": "20260101"}),
                        export([], params={"serviceKey": "test-only-credential"})):
            with self.subTest(payload=payload), self.assertRaises(DataError):
                parse_export(payload)
        self.assertEqual(parse_export(export([]))[0], [])

    def test_import_keeps_original_bytes_and_distinguishes_completeness(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "input.json"
            raw = json.dumps(export([award()]), ensure_ascii=False).encode("utf-8-sig")
            source.write_bytes(raw)
            run = import_exports([source], root / "run")
            manifest = json.loads((run / "manifest.json").read_text())
            self.assertEqual((run / manifest["pages"][0]["path"]).read_bytes(), raw)
            self.assertEqual(manifest["pages"][0]["sha256"], hashlib.sha256(raw).hexdigest())
            self.assertTrue(manifest["complete"])
            self.assertFalse(manifest["upstream_collection_verified"])
            self.assertEqual(manifest["complete_scope"], "local_import")
            self.assertIsNone(manifest["original_request_count"])
            report = preprocess(run)
            self.assertEqual(report["clean_passenger_rows"], 1)
            self.assertEqual(report["request_count"], 0)
            self.assertFalse(report["collection_complete"])
            with self.assertRaises(DataError):
                import_exports([source], run)
            with self.assertRaises(DataError):
                import_exports([source, source], root / "duplicate")
            (run / manifest["pages"][0]["path"]).write_text("{}")
            with self.assertRaises(DataError):
                preprocess(run)

    def test_sale_award_codes_and_age_match_model_contract(self):
        for changes, expected in (({"pbctStatCd": "0001"}, "not_awarded"),
                                  ({"pbctStatCd": 10}, "not_awarded"),
                                  ({"pbctStatCd": None}, "not_awarded"),
                                  ({"dspsMthodCd": "0002"}, "not_sale"),
                                  ({"yrmdl": "2027"}, "age_outside_model_contract"),
                                  ({"yrmdl": "1945"}, "age_outside_model_contract")):
            with self.subTest(changes=changes):
                row = normalize_record(award(**changes), "2026-11-04", "2026-01-01", "2026-11-03")
                self.assertIn(expected, row["exclusion_reasons"])
        row = normalize_record(award(yrmdl="2026"), "2026-11-04", "2026-01-01", "2026-11-03")
        self.assertEqual(row["exclusion_reasons"], "")

    def test_sensitive_feature_text_is_redacted_and_quarantined(self):
        values = ["쏘나타 123가4567", "연락 010-1234-5678", "user@example.test", "=HYPERLINK(test)"]
        for value in values:
            row = normalize_record(award(carMdlNm=value), "2026-11-04", "2026-01-01", "2026-11-03")
            self.assertIn("sensitive_or_unsafe_vehicle_attribute", row["exclusion_reasons"])
            self.assertNotEqual(row["model"], value)
            self.assertIn("[REDACTED]", row["model"])

    def test_cross_file_duplicate_conflict_and_baseline_overlap(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first, second = root / "first.json", root / "second.json"
            first.write_text(json.dumps(export([award(), award(cltrMngNo="sample-car-2")])) )
            second.write_text(json.dumps(export([award(), award(cltrMngNo="sample-car-2", scfbAmt="11000000"),
                                                   award(cltrMngNo="sample-car-3")])) )
            baseline = root / "baseline.csv"
            row = normalize_record(award(), "2026-11-04", "2026-01-01", "2026-11-03")
            with baseline.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=list(row))
                writer.writeheader()
                writer.writerow(row)
            run = import_exports([first, second], root / "run")
            report = preprocess(run, baseline)
            self.assertEqual(report["raw_rows"], 5)
            self.assertEqual(report["exact_duplicate_rows"], 1)
            self.assertEqual(report["conflicting_duplicate_events"], 1)
            self.assertEqual(report["clean_passenger_rows"], 2)
            self.assertEqual(report["excluded_rows"], 3)
            self.assertEqual(report["baseline_overlap"]["identical_clean_overlap"], 1)
            self.assertEqual(report["baseline_overlap"]["new_clean_events"], 1)
            self.assertFalse(report["baseline_overlap"]["baseline_rows_appended"])

    def test_manifest_cannot_redirect_to_other_raw_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "input.json"
            source.write_text(json.dumps(export([award()])))
            run = import_exports([source], root / "run")
            manifest = json.loads((run / "manifest.json").read_text())
            manifest["pages"][0]["path"] = "../input.json"
            (run / "manifest.json").write_text(json.dumps(manifest))
            with self.assertRaises(DataError):
                preprocess(run)


if __name__ == "__main__":
    unittest.main()
