"""Offline model-contract tests; fixture prices are synthetic and never mixed with API data."""

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from onbid_model import (
    FEATURES,
    build_evidence,
    chronological_group_split,
    load_bundle,
    load_data,
    make_candidates,
    residual_radius,
    train,
)


def fixture_data(count=400):
    dates = pd.date_range("2024-01-01", periods=count, freq="D", tz="UTC")
    mileage = np.asarray([10000 + (index % 50) * 3000 for index in range(count)])
    return pd.DataFrame({
        "source_record_id": ["fixture-event-" + str(index) for index in range(count)],
        "vehicle_group_id": ["fixture-vehicle-" + str(index) for index in range(count)],
        "event_date": dates.strftime("%Y-%m-%d"),
        "price_kind": "auction_award",
        "make": "fixture_make",
        "model": ["fixture_A" if index % 2 else "fixture_B" for index in range(count)],
        "model_year": [2018 + index % 3 for index in range(count)],
        "odometer_km": mileage,
        "displacement_cc": [None if index % 4 else 1600 for index in range(count)],
        "fuel": [None if index % 3 else "fixture_fuel" for index in range(count)],
        "vehicle_category": "승용차",
        "price_krw": 15000000 - mileage * 40,
    })


class ModelContractTests(unittest.TestCase):
    def test_calendar_split_drops_both_sides_of_repeated_vehicle(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.csv"
            data = fixture_data()
            data.loc[len(data) - 1, "vehicle_group_id"] = data.loc[0, "vehicle_group_id"]
            data.to_csv(path, index=False)
            splits, dropped, _ = chronological_group_split(load_data(path))
        self.assertEqual(len(dropped), 2)
        self.assertEqual(dropped["vehicle_group_id"].nunique(), 1)
        previous = None
        all_groups = set()
        for name in ("train", "validation", "calibration", "test"):
            segment = splits[name]
            self.assertFalse(all_groups.intersection(segment["vehicle_group_id"]))
            all_groups.update(segment["vehicle_group_id"])
            if previous is not None:
                self.assertLess(previous, segment["sold_at"].min())
            previous = segment["sold_at"].max()

    def test_unknown_category_prediction_does_not_fit_on_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.csv"
            fixture_data().to_csv(path, index=False)
            frame = load_data(path)
        estimator = make_candidates(n_estimators=3, n_jobs=1)["extra_trees_log"]
        estimator.fit(frame.iloc[:100][FEATURES], frame.iloc[:100]["price_krw"])
        unknown = frame.iloc[[101]][FEATURES].copy()
        unknown["model"] = "validation_only_model"
        self.assertTrue(np.isfinite(estimator.predict(unknown)).all())
        preprocessing = estimator.regressor_.named_steps["preprocessing"]
        encoder = preprocessing.named_transformers_["categorical"].named_steps["encoding"]
        self.assertNotIn("validation_only_model", encoder.categories_[1])

    def test_calibration_uses_finite_sample_rank(self):
        self.assertEqual(residual_radius([1, 2, 3, 4], [0, 0, 0, 0], coverage=0.8), 4)

    def test_training_and_evidence_refuse_unsupported_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "fixture.csv"
            fixture_data().to_csv(path, index=False)
            metadata = train(path, root / "model", n_estimators=3, n_jobs=1)
            self.assertEqual(metadata["selection_metric"], "validation_mae_krw")
            self.assertEqual(metadata["price_kind"], "auction_award")
            bundle = load_bundle(root / "model/model_bundle.joblib")
            vehicle = bundle["reference_train"].iloc[10][FEATURES].to_dict()
            evidence = build_evidence(bundle, vehicle, monthly_km=0, months=(0,))
            self.assertEqual(evidence["status"], "supported_exploratory")
            self.assertGreater(evidence["prediction_krw"], 0)
            self.assertEqual(evidence["llm_status"], "not_called")
            self.assertLessEqual(evidence["interval_low_krw"], evidence["prediction_krw"])
            self.assertTrue(evidence["comparable_cases"])
            json.dumps(evidence, allow_nan=False)
            vehicle["model"] = "never_observed_model"
            refused = build_evidence(bundle, vehicle)
            self.assertEqual(refused["status"], "deferred")
            self.assertNotIn("prediction_krw", refused)
            vehicle["model"] = bundle["reference_train"].iloc[10]["model"]
            vehicle["odometer_km"] = 999999999
            self.assertEqual(build_evidence(bundle, vehicle)["status"], "deferred")
            with self.assertRaises(ValueError):
                build_evidence(bundle, vehicle, monthly_km=-1)
            with self.assertRaises(ValueError):
                train(path, root / "model", n_estimators=3, n_jobs=1)


if __name__ == "__main__":
    unittest.main()
