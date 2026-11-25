from datetime import UTC, datetime
from decimal import Decimal

import pytest

from hyundai_experiments.errors import SchemaError
from hyundai_experiments.models import DistanceUnit, parse_odometer


def test_normal_preserves_units_and_separates_clocks(payload):
    received = datetime.now(UTC)
    result = parse_odometer(payload, received)
    assert result.readings[0].value == Decimal("45678")
    assert result.readings[0].unit == DistanceUnit.KILOMETRES
    assert result.readings[0].provider_observed_at.tzinfo is None
    assert result.readings[0].provider_timestamp_raw == "20261012153000"
    assert result.received_at == received


@pytest.mark.parametrize("unit", list(DistanceUnit))
def test_all_documented_units(payload, unit):
    payload["odometers"][0]["unit"] = int(unit)
    assert parse_odometer(payload, datetime.now(UTC)).readings[0].unit == unit


@pytest.mark.parametrize("key", ["date", "timestamp", "value", "unit"])
@pytest.mark.parametrize("mode", ["missing", "null"])
def test_no_defaults_for_missing_or_null(payload, key, mode):
    row = payload["odometers"][0]
    if mode == "missing":
        del row[key]
    else:
        row[key] = None
    with pytest.raises(SchemaError):
        parse_odometer(payload, datetime.now(UTC))


@pytest.mark.parametrize("rows", [[], None, {}, [None], "not-an-array"])
def test_empty_null_and_wrong_container(payload, rows):
    payload["odometers"] = rows
    with pytest.raises(SchemaError):
        parse_odometer(payload, datetime.now(UTC))


@pytest.mark.parametrize("unit", [4, -1, 77, "1", True, None, 1.0])
def test_unknown_units_are_not_normalized(payload, unit):
    payload["odometers"][0]["unit"] = unit
    with pytest.raises(SchemaError, match="unit:"):
        parse_odometer(payload, datetime.now(UTC))


@pytest.mark.parametrize("value", [None, True, "123", -1, float("nan"), float("inf")])
def test_invalid_distance(payload, value):
    payload["odometers"][0]["value"] = value
    with pytest.raises(SchemaError, match="value:"):
        parse_odometer(payload, datetime.now(UTC))


def test_explicit_zero_is_valid(payload):
    payload["odometers"][0]["value"] = 0
    assert parse_odometer(payload, datetime.now(UTC)).readings[0].value == Decimal(0)


@pytest.mark.parametrize(
    "key,value",
    [
        ("date", "20260230"),
        ("timestamp", "20261012999999"),
        ("date", "2026-10-12"),
        ("timestamp", "20261012153000Z"),
    ],
)
def test_invalid_provider_times(payload, key, value):
    payload["odometers"][0][key] = value
    with pytest.raises(SchemaError):
        parse_odometer(payload, datetime.now(UTC))


def test_bad_second_row_does_not_yield_partial_normal_data(payload):
    payload["odometers"].append({"value": 20, "unit": None})
    with pytest.raises(SchemaError):
        parse_odometer(payload, datetime.now(UTC))


@pytest.mark.parametrize("payload", [None, [], {}, {"odometers": []}])
def test_required_envelope(payload):
    with pytest.raises(SchemaError):
        parse_odometer(payload, datetime.now(UTC))
