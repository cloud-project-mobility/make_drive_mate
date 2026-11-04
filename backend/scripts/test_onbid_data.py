"""Offline regression checks for auction preprocessing boundaries."""

import hashlib
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from onbid_data import DataError, disposition_reasons, integer, month_windows, normalize_record, parse_response, preprocess


def award(**changes):
    record = {
        "cltrMngNo": "sample-car-1", "pbctCdtnNo": 1, "cltrOpbdDt": "202610011000",
        "pbctStatCd": "0010", "dspsMthodCd": "0001", "cltrUsgSclsCtgrNm": "승용차",
        "yrmdl": "2020", "drvDstc": "100,000", "scfbAmt": "10000000", "carMdlNm": " 쏘나타 ",
    }
    record.update(changes)
    return record


class PreprocessingTests(unittest.TestCase):
    def test_missing_features_are_not_invented(self):
        result = normalize_record(award(), "2026-11-04", "2026-10-01", "2026-10-31")
        self.assertEqual(result["price_krw"], 10000000)
        self.assertEqual(result["odometer_km"], 100000)
        self.assertEqual(result["age_years_approx"], 6)
        self.assertEqual(result["model"], "쏘나타")
        self.assertIsNone(result["make"])
        self.assertTrue(result["make_missing"])
        self.assertEqual(result["exclusion_reasons"], "")
        self.assertNotIn("scfbAmt", result)

    def test_malformed_and_non_passenger_are_excluded(self):
        result = normalize_record(award(drvDstc=-1, scfbAmt=0, yrmdl=2030,
                                  cltrUsgSclsCtgrNm="화물차", cltrOpbdDt="202602301000"),
                                  "2026-11-04", "2026-02-01", "2026-02-28")
        for reason in ("invalid_odometer", "invalid_price", "invalid_event_date", "non_passenger_category"):
            self.assertIn(reason, result["exclusion_reasons"])

    def test_zero_mileage_is_quarantined_not_replaced(self):
        result = normalize_record(award(drvDstc=0), "2026-11-04", "2026-10-01", "2026-10-31")
        self.assertEqual(result["odometer_km"], 0)
        self.assertIn("zero_odometer", result["review_flags"])
        self.assertIn("zero_odometer", result["exclusion_reasons"])

    def test_scrap_and_batch_prices_are_not_single_car_targets(self):
        self.assertEqual(disposition_reasons("불용 공용차량(승용 141대) 폐차 매각"),
                         ["scrap_or_parts_sale", "multi_vehicle_lot"])
        self.assertEqual(disposition_reasons("승용차 외 1대"), ["multi_vehicle_lot"])
        self.assertEqual(disposition_reasons("쏘나타 외 9건"), ["multi_item_title_requires_review"])
        self.assertEqual(disposition_reasons("승용차 1대 매각"), [])
        self.assertEqual(disposition_reasons("승용차 매각(폐차불가)"), [])
        self.assertEqual(disposition_reasons("고철매각(실습용자동차)"), ["scrap_or_parts_sale"])
        self.assertEqual(disposition_reasons("기아 카니발(온비드 점검용)"), ["non_vehicle_test_record"])

    def test_high_price_is_not_automatically_truncated(self):
        result = normalize_record(award(scfbAmt=400000000, onbidCltrNm="승용차 1대 매각"),
                                  "2026-11-04", "2026-10-01", "2026-10-31")
        self.assertEqual(result["exclusion_reasons"], "")
        self.assertIn("price_extreme_requires_review", result["review_flags"])

    def test_numeric_formats_and_calendar_windows(self):
        self.assertEqual(integer("123,456 km"), 123456)
        self.assertIsNone(integer("123.4"))
        self.assertIsNone(integer("NaN"))
        self.assertEqual(list(month_windows(date(2024, 2, 28), date(2024, 3, 2))),
                         [(date(2024, 2, 28), date(2024, 2, 29)), (date(2024, 3, 1), date(2024, 3, 2))])

    def test_error_response_cannot_be_reported_as_no_data(self):
        with self.assertRaises(DataError):
            parse_response({"header": {"resultCode": "30"}, "body": {}})

    def test_duplicate_conflicts_and_checksum_integrity(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            payload = {"header": {"resultCode": "00"}, "body": {"numOfRows": 1000, "totalCount": 4,
                "items": {"item": [award(), award(), award(cltrMngNo="sample-car-2"),
                                      award(cltrMngNo="sample-car-2", scfbAmt=11000000)]}}}
            raw = json.dumps(payload).encode()
            (run / "raw.json").write_bytes(raw)
            manifest = {"complete": True, "row_count": 4, "request_count": 1,
                        "date_start": "2026-10-01", "date_end": "2026-10-31", "pages": [
                            {"path": "raw.json", "sha256": hashlib.sha256(raw).hexdigest(),
                             "observed_at": "2026-11-04", "date_start": "2026-10-01", "date_end": "2026-10-31"}]}
            (run / "manifest.json").write_text(json.dumps(manifest))
            report = preprocess(run)
            self.assertEqual(report["exact_duplicate_rows"], 1)
            self.assertEqual(report["conflicting_duplicate_events"], 1)
            self.assertEqual(report["clean_passenger_rows"], 1)
            self.assertEqual(report["excluded_rows"], 3)
            (run / "raw.json").write_text("{}")
            with self.assertRaises(DataError):
                preprocess(run)


if __name__ == "__main__":
    unittest.main()
