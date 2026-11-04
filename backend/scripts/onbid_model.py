"""Train and explain an exploratory Onbid auction-price model, locally or in Colab.

This module never calls an LLM or reads API credentials. Prices are auction awards,
not consumer retail values. Future inputs are conditional scenarios, not forecasts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import UTC, datetime
from pathlib import Path

try:
    import joblib
    import numpy as np
    import pandas as pd
    import sklearn
    from sklearn.base import BaseEstimator, RegressorMixin
    from sklearn.compose import ColumnTransformer, TransformedTargetRegressor
    from sklearn.dummy import DummyRegressor
    from sklearn.ensemble import ExtraTreesRegressor, RandomForestRegressor
    from sklearn.impute import SimpleImputer
    from sklearn.inspection import permutation_importance
    from sklearn.metrics import mean_absolute_error, mean_squared_error
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder
except ImportError as exc:
    raise ImportError(
        "Install pandas, numpy, scikit-learn and joblib in the notebook environment."
    ) from exc


NUMERIC_FEATURES = ["age_years", "odometer_km", "engine_cc"]
CATEGORICAL_FEATURES = ["make", "model", "fuel", "vehicle_category"]
FEATURES = NUMERIC_FEATURES + CATEGORICAL_FEATURES
SPLIT_NAMES = ["train", "validation", "calibration", "test"]
MIN_SPLIT_ROWS = {"train": 80, "validation": 20, "calibration": 20, "test": 20}
LIMITATIONS = [
    "온비드 공매 낙찰가격이며 소비자 판매가격·딜러 매입가격이 아닙니다.",
    "사고·수리·침수·트림·옵션은 확인된 입력이 없어 반영하지 않았습니다.",
    "연식과 주행거리를 바꾼 결과는 시장 조건 고정 시나리오이며 미래 시세 예측이 아닙니다.",
    "보정 구간의 오차로 만든 참고 범위이며 시장 변화에도 포함률이 유지된다는 보장은 없습니다.",
    "유사 사례와 변수 중요도는 통계적 근거이며 가격 변화의 인과관계 증명이 아닙니다.",
]


class GroupMedianRegressor(RegressorMixin, BaseEstimator):
    """Train-only make/model/age-band medians, with model and global fallbacks."""

    def __init__(self, min_group_size=5):
        self.min_group_size = min_group_size

    @staticmethod
    def _keys(frame):
        make = frame["make"].fillna("unknown").astype(str)
        model = frame["model"].fillna("unknown").astype(str)
        age_band = (frame["age_years"] // 3).astype(int)
        return list(zip(make, model, age_band, strict=True)), list(zip(make, model, strict=True))

    def fit(self, features, target):
        target = np.asarray(target, dtype=float)
        exact, model = self._keys(features)
        self.global_median_ = float(np.median(target))
        self.exact_medians_ = self._medians(exact, target)
        self.model_medians_ = self._medians(model, target)
        self.n_features_in_ = len(features.columns)
        return self

    def _medians(self, keys, target):
        grouped = {}
        for key, value in zip(keys, target, strict=True):
            grouped.setdefault(key, []).append(value)
        return {
            key: float(np.median(values))
            for key, values in grouped.items()
            if len(values) >= self.min_group_size
        }

    def predict(self, features):
        exact, model = self._keys(features)
        return np.asarray(
            [
                self.exact_medians_.get(
                    exact_key, self.model_medians_.get(model_key, self.global_median_)
                )
                for exact_key, model_key in zip(exact, model, strict=True)
            ]
        )


def _write_json(path, value):
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8"
    )


def load_data(csv_path):
    """Validate the collector contract; only pre-auction vehicle attributes enter X."""
    frame = pd.read_csv(csv_path, dtype={"vehicle_group_id": str, "source_record_id": str})
    aliases = {
        "event_date": "sold_at",
        "model_generation": "model",
        "category": "vehicle_category",
        "displacement_cc": "engine_cc",
        "mileage_km": "odometer_km",
    }
    for source, target in aliases.items():
        if target not in frame and source in frame:
            frame = frame.rename(columns={source: target})
    required = {"sold_at", "vehicle_group_id", "model", "model_year", "odometer_km", "price_krw"}
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError("Missing required clean-data columns: " + ", ".join(missing))
    if "price_kind" in frame and not frame["price_kind"].eq("auction_award").all():
        raise ValueError("Only auction_award records are accepted; do not mix price domains.")
    frame["sold_at"] = pd.to_datetime(frame["sold_at"], errors="raise", utc=True)
    for name in ["model_year", "odometer_km", "price_krw"]:
        frame[name] = pd.to_numeric(frame[name], errors="raise")
    # Model year supplies only approximate age, not exact first-registration age.
    frame["age_years"] = frame["sold_at"].dt.year - frame["model_year"]
    for name in CATEGORICAL_FEATURES:
        if name not in frame:
            frame[name] = "unknown"
        frame[name] = frame[name].fillna("unknown").astype(str).str.strip().replace("", "unknown")
    if "engine_cc" not in frame:
        frame["engine_cc"] = np.nan
    frame["engine_cc"] = pd.to_numeric(frame["engine_cc"], errors="coerce")
    if frame["vehicle_group_id"].isna().any() or frame["vehicle_group_id"].str.strip().eq("").any():
        raise ValueError("Vehicle group IDs must be present to prevent repeated-car leakage.")
    invalid = (
        frame[["price_krw", "odometer_km", "model_year"]].isna().any(axis=1)
        | ~np.isfinite(frame[["price_krw", "odometer_km", "model_year"]]).all(axis=1)
        | frame["price_krw"].le(0)
        | frame["odometer_km"].lt(0)
        | frame["age_years"].lt(0)
        | frame["age_years"].gt(80)
        | frame["model"].eq("unknown")
    )
    if invalid.any():
        raise ValueError(f"Clean input contains {int(invalid.sum())} invalid core records.")
    if "source_record_id" not in frame:
        frame["source_record_id"] = (
            frame["vehicle_group_id"].astype(str) + "|" + frame["sold_at"].astype(str)
        )
    if frame["source_record_id"].duplicated().any():
        raise ValueError("Duplicate event IDs remain in input; resolve them before training.")
    return frame.sort_values(["sold_at", "source_record_id"]).reset_index(drop=True)


def chronological_group_split(frame, minimum_rows=None):
    """Calendar-duration 60/15/10/15 split; drop all boundary-crossing car groups."""
    if frame.empty:
        raise ValueError("The clean input dataset is empty.")
    lower = frame["sold_at"].min().normalize()
    upper = frame["sold_at"].max().normalize() + pd.Timedelta(days=1)
    if upper - lower < pd.Timedelta(days=60):
        raise ValueError("At least 60 calendar days are needed for an exploratory temporal split.")
    edges = [lower + (upper - lower) * ratio for ratio in (0.60, 0.75, 0.85)]
    labels = np.select(
        [frame["sold_at"] < edge for edge in edges], SPLIT_NAMES[:3], default="test"
    )
    assigned = frame.assign(split=labels)
    group_split_counts = assigned.groupby("vehicle_group_id")["split"].nunique()
    crossing = set(group_split_counts[group_split_counts > 1].index)
    dropped = assigned[assigned["vehicle_group_id"].isin(crossing)].copy()
    kept = assigned[~assigned["vehicle_group_id"].isin(crossing)].copy()
    splits = {name: kept[kept["split"].eq(name)].copy() for name in SPLIT_NAMES}
    minimum_rows = MIN_SPLIT_ROWS if minimum_rows is None else minimum_rows
    insufficient = {
        name: len(data) for name, data in splits.items() if len(data) < minimum_rows[name]
    }
    if insufficient:
        raise ValueError(f"Too few rows after temporal/group split: {insufficient}")
    return splits, dropped, {
        "method": "calendar_duration_60_15_10_15_purge_crossing_groups",
        "start": lower.isoformat(),
        "boundaries": [edge.isoformat() for edge in edges],
        "end_exclusive": upper.isoformat(),
        "excluded_crossing_groups": len(crossing),
        "excluded_crossing_rows": len(dropped),
        "segments": {
            name: {
                "rows": len(data),
                "groups": int(data["vehicle_group_id"].nunique()),
                "first_date": data["sold_at"].min().isoformat(),
                "last_date": data["sold_at"].max().isoformat(),
            }
            for name, data in splits.items()
        },
    }


def make_candidates(n_estimators=200, n_jobs=-1):
    categorical = Pipeline(
        [
            ("missing", SimpleImputer(strategy="constant", fill_value="unknown")),
            ("encoding", OneHotEncoder(handle_unknown="infrequent_if_exist", min_frequency=5)),
        ]
    )
    numeric = SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True)

    def estimator(regressor):
        preprocessing = ColumnTransformer(
            [
                ("numeric", numeric, NUMERIC_FEATURES),
                ("categorical", categorical, CATEGORICAL_FEATURES),
            ]
        )
        return TransformedTargetRegressor(
            regressor=Pipeline([("preprocessing", preprocessing), ("model", regressor)]),
            func=np.log1p,
            inverse_func=np.expm1,
        )

    return {
        "median": DummyRegressor(strategy="median"),
        "model_age_median": GroupMedianRegressor(min_group_size=5),
        "extra_trees_log": estimator(
            ExtraTreesRegressor(
                n_estimators=n_estimators, min_samples_leaf=3, max_features=1.0,
                random_state=42, n_jobs=n_jobs,
            )
        ),
        "random_forest_log": estimator(
            RandomForestRegressor(
                n_estimators=n_estimators, min_samples_leaf=3, max_features=0.8,
                random_state=42, n_jobs=n_jobs,
            )
        ),
    }


def regression_metrics(actual, predicted):
    actual, predicted = np.asarray(actual, dtype=float), np.asarray(predicted, dtype=float)
    errors = np.abs(actual - predicted)
    return {
        "rows": len(actual),
        "mae_krw": float(mean_absolute_error(actual, predicted)),
        "mae_manwon": float(mean_absolute_error(actual, predicted) / 10000),
        "median_absolute_error_krw": float(np.median(errors)),
        "rmse_krw": float(math.sqrt(mean_squared_error(actual, predicted))),
        "wape_pct": float(errors.sum() / np.abs(actual).sum() * 100),
    }


def residual_radius(actual, predicted, coverage=0.80):
    residuals = np.abs(np.asarray(actual) - np.asarray(predicted))
    if not len(residuals):
        raise ValueError("Calibration residuals are empty.")
    rank = min(len(residuals), math.ceil((len(residuals) + 1) * coverage))
    return float(np.sort(residuals)[rank - 1])


def assess_support(features, reference, support_ranges):
    """Apply the same train-only support rule during evaluation and inference."""
    values = features.iloc[0]
    same_model = reference[reference["model"].eq(values["model"])]
    if values["make"] != "unknown":
        same_model = same_model[same_model["make"].eq(values["make"])]
    reasons, warnings = [], []
    if same_model.empty:
        reasons.append("unseen_model_or_make_model_combination")
    elif len(same_model) < 10:
        warnings.append("similar_model_training_rows_below_10")
    for name, bounds in support_ranges.items():
        value = values[name]
        if pd.notna(value) and not bounds["min"] <= value <= bounds["max"]:
            reasons.append("outside_training_range:" + name)
    for name in CATEGORICAL_FEATURES:
        if values[name] not in set(reference[name]):
            warnings.append("unseen_category:" + name)
    return reasons, warnings, same_model


def train(csv_path, output_dir, n_estimators=200, n_jobs=-1):
    """Fit on train only, choose on validation, calibrate, then evaluate once on test."""
    csv_path, output_dir = Path(csv_path), Path(output_dir)
    if output_dir.exists() and any(output_dir.iterdir()):
        raise ValueError("Output directory is not empty; choose a new model run directory.")
    frame = load_data(csv_path)
    splits, dropped, split_info = chronological_group_split(frame)
    train_frame, validation, calibration, test = (splits[name] for name in SPLIT_NAMES)
    candidates = make_candidates(n_estimators=n_estimators, n_jobs=n_jobs)
    validation_scores = {}
    for name, estimator in candidates.items():
        estimator.fit(train_frame[FEATURES], train_frame["price_krw"])
        prediction = estimator.predict(validation[FEATURES])
        validation_scores[name] = regression_metrics(validation["price_krw"], prediction)
    winner_name = min(validation_scores, key=lambda name: validation_scores[name]["mae_krw"])
    winner = candidates[winner_name]
    calibration_prediction = winner.predict(calibration[FEATURES])
    radius = residual_radius(calibration["price_krw"], calibration_prediction)
    prediction = winner.predict(test[FEATURES])
    lower, upper = np.maximum(0, prediction - radius), prediction + radius
    test_metrics = regression_metrics(test["price_krw"], prediction)
    covered = (test["price_krw"].to_numpy() >= lower) & (test["price_krw"].to_numpy() <= upper)
    test_metrics["empirical_interval_coverage_pct"] = float(covered.mean() * 100)
    test_metrics["mean_interval_width_krw"] = float(np.mean(upper - lower))
    baseline_test = {
        name: regression_metrics(test["price_krw"], candidates[name].predict(test[FEATURES]))
        for name in ("median", "model_age_median")
    }
    importance = permutation_importance(
        winner, validation[FEATURES], validation["price_krw"],
        scoring="neg_mean_absolute_error", n_repeats=5, random_state=42, n_jobs=1,
    )
    importance_rows = sorted(
        [
            {"feature": name, "mae_increase_krw": float(mean), "std_krw": float(std)}
            for name, mean, std in zip(
                FEATURES, importance.importances_mean, importance.importances_std, strict=True
            )
        ],
        key=lambda row: row["mae_increase_krw"], reverse=True,
    )
    prediction_columns = [
        "source_record_id", "vehicle_group_id", "sold_at", "make", "model", "price_krw"
    ]
    test_predictions = test[prediction_columns].copy()
    test_predictions["prediction_krw"] = prediction
    test_predictions["interval_low_krw"] = lower
    test_predictions["interval_high_krw"] = upper
    subgroup_metrics = []
    for column in ("model", "make", "vehicle_category"):
        for value, group in test.groupby(column):
            indices = test.index.get_indexer(group.index)
            subgroup_metrics.append({
                "group_by": column, "group": value,
                "small_sample": len(group) < 30,
                **regression_metrics(group["price_krw"], prediction[indices]),
            })
    support_ranges = {
        column: {"min": float(train_frame[column].min()), "max": float(train_frame[column].max())}
        for column in NUMERIC_FEATURES if train_frame[column].notna().any()
    }
    support_reasons = [
        assess_support(test.iloc[[index]][FEATURES], train_frame, support_ranges)[0]
        for index in range(len(test))
    ]
    supported = np.asarray([not reasons for reasons in support_reasons])
    support_metrics = None
    if supported.any():
        support_metrics = regression_metrics(test["price_krw"].to_numpy()[supported], prediction[supported])
        support_metrics["empirical_interval_coverage_pct"] = float(covered[supported].mean() * 100)
    reason_counts = {}
    for reasons in support_reasons:
        for reason in reasons:
            reason_counts[reason] = reason_counts.get(reason, 0) + 1
    test_predictions["service_supported"] = supported
    test_predictions["service_defer_reasons"] = [";".join(reasons) for reasons in support_reasons]
    metadata = {
        "status": "exploratory_auction_model",
        "price_kind": "auction_award",
        "created_at": datetime.now(UTC).isoformat(),
        "source_sha256": hashlib.sha256(csv_path.read_bytes()).hexdigest(),
        "versions": {
            "sklearn": sklearn.__version__, "pandas": pd.__version__, "numpy": np.__version__
        },
        "features": FEATURES,
        "split": split_info,
        "selection_metric": "validation_mae_krw",
        "selected_model": winner_name,
        "validation_scores": validation_scores,
        "test_metrics": test_metrics,
        "baseline_test_metrics": baseline_test,
        "interval": {
            "nominal_coverage": 0.80, "absolute_radius_krw": radius,
            "calibration_rows": len(calibration),
            "method": "heldout_absolute_residual_order_statistic",
            "time_shift_warning": "Temporal distribution shift can invalidate nominal coverage.",
        },
        "support_ranges": support_ranges,
        "service_support_audit": {
            "rule": "same_inference_rule_known_model_make_and_training_numeric_bounds",
            "test_rows": len(test),
            "supported_rows": int(supported.sum()),
            "deferred_rows": int((~supported).sum()),
            "supported_percent": float(supported.mean() * 100),
            "defer_reason_counts": reason_counts,
            "supported_test_metrics": support_metrics,
            "interpretation": "Conditional subset performance; report alongside full test metrics.",
        },
        "validation_feature_importance": importance_rows,
        "limitations": LIMITATIONS,
        "gate_notes": [
            "This exploratory run is not validation of consumer prices or long-horizon forecasts.",
            *(["Fewer than 1000 clean records."] if len(frame) < 1000 else []),
            *(["Fewer than 150 final test rows."] if len(test) < 150 else []),
        ],
    }
    evidence_columns = ["source_record_id", "vehicle_group_id", "sold_at", "price_krw"] + FEATURES
    bundle = {
        "model": winner, "metadata": metadata,
        "reference_train": train_frame[evidence_columns].copy(),
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    _write_json(output_dir / "metrics.json", metadata)
    _write_json(output_dir / "subgroup_metrics.json", subgroup_metrics)
    pd.DataFrame(importance_rows).to_csv(
        output_dir / "validation_feature_importance.csv", index=False
    )
    test_predictions.to_csv(output_dir / "test_predictions.csv", index=False)
    assignment_columns = ["source_record_id", "vehicle_group_id", "sold_at", "split"]
    pd.concat(splits.values())[assignment_columns].to_csv(
        output_dir / "split_assignments.csv", index=False
    )
    dropped[assignment_columns].to_csv(
        output_dir / "excluded_boundary_groups.csv", index=False
    )
    joblib.dump(bundle, output_dir / "model_bundle.joblib")
    return metadata


def load_bundle(path):
    """Load only your own trusted artifact: joblib files can execute code."""
    return joblib.load(path)


def _vehicle_frame(vehicle):
    row = {name: vehicle.get(name, "unknown") for name in CATEGORICAL_FEATURES}
    row = {
        name: ("unknown" if value is None else str(value).strip() or "unknown")
        for name, value in row.items()
    }
    for name in NUMERIC_FEATURES:
        value = vehicle.get(name)
        optional_nan = (
            name == "engine_cc" and isinstance(value, (float, np.floating)) and math.isnan(value)
        )
        if value is None or value == "" or optional_nan:
            if name != "engine_cc":
                raise ValueError(f"Required vehicle input is missing: {name}")
            row[name] = np.nan
        else:
            if isinstance(value, (bool, np.bool_)):
                raise ValueError(f"Vehicle input must be numeric, not boolean: {name}")
            row[name] = float(value)
            if not math.isfinite(row[name]) or row[name] < 0:
                raise ValueError(f"Vehicle input must be finite and non-negative: {name}")
    return pd.DataFrame([row], columns=FEATURES)


def build_evidence(bundle, vehicle, monthly_km=1000, months=(0, 6, 12), monthly_upkeep_krw=0):
    """Produce validated model facts for an explanation layer; never generate prose with an LLM."""
    if not math.isfinite(monthly_km) or monthly_km < 0:
        raise ValueError("monthly_km must be finite and non-negative.")
    if not math.isfinite(monthly_upkeep_krw) or monthly_upkeep_krw < 0:
        raise ValueError("monthly_upkeep_krw must be finite and non-negative.")
    if not months or any(not isinstance(month, int) or month < 0 or month > 24 for month in months):
        raise ValueError("Scenario months must be integers between 0 and 24.")
    features = _vehicle_frame(vehicle)
    metadata, reference = bundle["metadata"], bundle["reference_train"]
    reasons, warnings, same_model = assess_support(features, reference, metadata["support_ranges"])
    safe_input = {
        name: (None if pd.isna(value) else value)
        for name, value in features.iloc[0].to_dict().items()
    }
    evidence = {
        "status": "deferred" if reasons else "supported_exploratory",
        "price_kind": "auction_award",
        "selected_model": metadata["selected_model"],
        "model_created_at": metadata["created_at"],
        "input": safe_input,
        "training_same_model_count": len(same_model),
        "validation_mae_krw": metadata["validation_scores"][metadata["selected_model"]]["mae_krw"],
        "test_mae_krw": metadata["test_metrics"]["mae_krw"],
        "test_interval_coverage_pct": metadata["test_metrics"]["empirical_interval_coverage_pct"],
        "defer_reasons": reasons,
        "warnings": warnings,
        "limitations": LIMITATIONS,
        "scenarios": [],
        "comparable_cases": [],
        "llm_status": "not_called",
    }
    if reasons:
        return evidence
    current_prediction = float(bundle["model"].predict(features)[0])
    radius = metadata["interval"]["absolute_radius_krw"]
    evidence["prediction_krw"] = round(current_prediction)
    evidence["interval_low_krw"] = round(max(0, current_prediction - radius))
    evidence["interval_high_krw"] = round(current_prediction + radius)
    for month in sorted(set(months)):
        changed = features.copy()
        changed["age_years"] += month / 12
        changed["odometer_km"] += monthly_km * month
        outside = [
            name for name, bounds in metadata["support_ranges"].items()
            if pd.notna(changed.iloc[0][name])
            and not bounds["min"] <= changed.iloc[0][name] <= bounds["max"]
        ]
        scenario = {
            "evidence_id": "scenario_" + str(month), "months": month,
            "age_years": float(changed.iloc[0]["age_years"]),
            "odometer_km": float(changed.iloc[0]["odometer_km"]),
            "market_assumption": "held_constant_not_calendar_forecast",
        }
        if outside:
            scenario.update(status="deferred", outside_training_range=outside)
        else:
            value = float(bundle["model"].predict(changed)[0])
            scenario.update(
                status="conditional_scenario", prediction_krw=round(value),
                interval_low_krw=round(max(0, value - radius)),
                interval_high_krw=round(value + radius),
                depreciation_krw=round(current_prediction - value),
                assumed_upkeep_krw=round(monthly_upkeep_krw * month),
                assumed_combined_cost_krw=round(
                    current_prediction - value + monthly_upkeep_krw * month
                ),
            )
            if month and value > current_prediction:
                warnings.append("non_monotonic_scenario_at_month:" + str(month))
        evidence["scenarios"].append(scenario)
    ranked = same_model.assign(
        distance=(same_model["age_years"] - features.iloc[0]["age_years"]).abs() / 3
        + (same_model["odometer_km"] - features.iloc[0]["odometer_km"]).abs() / 50000
    ).sort_values(["distance", "sold_at"])
    for rank, (_, row) in enumerate(ranked.head(3).iterrows(), 1):
        evidence["comparable_cases"].append({
            "evidence_id": "comparison_" + str(rank),
            "event_date": row["sold_at"].date().isoformat(),
            "model": row["model"], "age_years": float(row["age_years"]),
            "odometer_km": float(row["odometer_km"]), "auction_award_krw": round(row["price_krw"]),
            "selection": "same_model_nearest_age_and_mileage_training_only",
        })
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    training = subparsers.add_parser("train")
    training.add_argument("--input", required=True)
    training.add_argument("--output-dir", required=True)
    training.add_argument("--n-estimators", type=int, default=200)
    args = parser.parse_args()
    metadata = train(args.input, args.output_dir, args.n_estimators)
    print(json.dumps(
        {"selected_model": metadata["selected_model"], "test_metrics": metadata["test_metrics"]},
        ensure_ascii=False, indent=2,
    ))


if __name__ == "__main__":
    main()
