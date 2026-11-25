"""Odometer parser based on Hyundai's public success example, reviewed 2026-10-13.

The table calls odometers an object but its example is an array. We require the
non-empty array in the example; an object is left unverified, never coerced.
"""

import math
import re
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from enum import IntEnum

from .errors import SchemaError


class DistanceUnit(IntEnum):
    FEET = 0
    KILOMETRES = 1
    METRES = 2
    MILES = 3


@dataclass(frozen=True, repr=False)
class OdometerReading:
    query_date_raw: str
    provider_timestamp_raw: str
    provider_observed_at: datetime  # naive deliberately: provider timezone is unknown
    value: Decimal
    unit: DistanceUnit


@dataclass(frozen=True, repr=False)
class OdometerResponse:
    readings: tuple[OdometerReading, ...]
    received_at: datetime  # timezone-aware UTC, generated locally


def _date(value: object, pattern: str, fmt: str, field_name: str) -> datetime:
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        raise SchemaError(f"{field_name}:invalid_format")
    try:
        return datetime.strptime(value, fmt)
    except ValueError:
        raise SchemaError(f"{field_name}:invalid_calendar_value") from None


def parse_odometer(payload: object, received_at: datetime) -> OdometerResponse:
    if not isinstance(payload, dict):
        raise SchemaError("root:expected_object")
    if any(key in payload for key in ("errCode", "errMsg", "errId", "error", "errors")):
        raise SchemaError("root:provider_error_envelope")
    if not isinstance(payload.get("msgId"), str) or not payload["msgId"].strip():
        raise SchemaError("msgId:missing_or_invalid")
    raw = payload.get("odometers")
    if not isinstance(raw, list) or not raw:
        raise SchemaError("odometers:expected_nonempty_array")
    readings = []
    for row in raw:
        if not isinstance(row, dict):
            raise SchemaError("odometers.item:expected_object")
        _date(row.get("date"), r"[0-9]{8}", "%Y%m%d", "date")
        observed = _date(row.get("timestamp"), r"[0-9]{14}", "%Y%m%d%H%M%S", "timestamp")
        value, unit = row.get("value"), row.get("unit")
        if type(value) not in (int, float) or (
            isinstance(value, float) and not math.isfinite(value)
        ):
            raise SchemaError("value:expected_finite_number")
        if value < 0:
            raise SchemaError("value:negative_distance")
        if type(unit) is not int or unit not in tuple(DistanceUnit):
            raise SchemaError("unit:unknown_or_missing")
        readings.append(
            OdometerReading(
                row["date"], row["timestamp"], observed, Decimal(str(value)), DistanceUnit(unit)
            )
        )
    if received_at.tzinfo is None or received_at.utcoffset() is None:
        raise SchemaError("received_at:timezone_required")
    return OdometerResponse(tuple(readings), received_at)
