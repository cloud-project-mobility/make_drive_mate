"""Typed models for the remaining officially documented Sample endpoints."""

import math
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from enum import IntEnum

from .catalog import APIS
from .errors import SchemaError
from .models import DistanceUnit, OdometerResponse, _date, parse_odometer


class TimeUnit(IntEnum):
    HOURS = 0
    MINUTES = 1
    MILLISECONDS = 2
    SECONDS = 3


@dataclass(frozen=True, repr=False)
class DistanceResponse:
    value: Decimal
    unit: DistanceUnit
    provider_timestamp_raw: str
    provider_observed_at: datetime
    received_at: datetime
    phev_total_value: Decimal | None = None
    phev_total_unit: DistanceUnit | None = None


@dataclass(frozen=True, repr=False)
class WarningResponse:
    status: bool  # Only the named warning; false does not certify vehicle health.
    received_at: datetime
    provider_observed_at: None = None  # Not supplied in this documented response.


@dataclass(frozen=True, repr=False)
class BatteryResponse:
    soc: Decimal
    provider_timestamp_raw: str
    provider_observed_at: datetime
    received_at: datetime


@dataclass(frozen=True, repr=False)
class TargetSoc:
    plug_type: int | None
    target_soc_level: Decimal | None


@dataclass(frozen=True, repr=False)
class ChargingResponse:
    battery_plugin: int
    battery_charge: bool
    soc: Decimal
    remain_value: Decimal
    remain_unit: TimeUnit
    provider_timestamp_raw: str
    provider_observed_at: datetime
    received_at: datetime
    target_soc: TargetSoc | None


ApiResponse = (
    OdometerResponse | DistanceResponse | WarningResponse | BatteryResponse | ChargingResponse
)


def _number(value: object, name: str, maximum: int | None = None) -> Decimal:
    if type(value) not in (int, float) or (isinstance(value, float) and not math.isfinite(value)):
        raise SchemaError(f"{name}:expected_finite_number")
    if value < 0 or (maximum is not None and value > maximum):
        raise SchemaError(f"{name}:out_of_range")
    return Decimal(str(value))


def _code(value: object, name: str, allowed: tuple[int, ...]) -> int:
    if type(value) is not int or value not in allowed:
        raise SchemaError(f"{name}:unknown_or_missing")
    return value


def _boolean(value: object, name: str) -> bool:
    if type(value) is not bool:
        raise SchemaError(f"{name}:expected_boolean")
    return value


def parse_status(api: str, payload: object, received_at: datetime) -> ApiResponse:
    kind = APIS[api].kind
    if kind == "odometer":
        return parse_odometer(payload, received_at)
    if not isinstance(payload, dict):
        raise SchemaError("root:expected_object")
    if any(key in payload for key in ("errCode", "errMsg", "errId", "error", "errors")):
        raise SchemaError("root:provider_error_envelope")
    if not isinstance(payload.get("msgId"), str) or not payload["msgId"].strip():
        raise SchemaError("msgId:missing_or_invalid")
    if received_at.tzinfo is None or received_at.utcoffset() is None:
        raise SchemaError("received_at:timezone_required")
    if kind == "warning":
        return WarningResponse(_boolean(payload.get("status"), "status"), received_at)
    raw_time = payload.get("timestamp")
    observed = _date(raw_time, r"[0-9]{14}", "%Y%m%d%H%M%S", "timestamp")
    if kind == "distance":
        value = _number(payload.get("value"), "value")
        unit = DistanceUnit(_code(payload.get("unit"), "unit", (0, 1, 2, 3)))
        total, total_unit = None, None
        if "phevTotalValue" in payload or "phevTotalUnit" in payload:
            total = _number(payload.get("phevTotalValue"), "phevTotalValue")
            total_unit = DistanceUnit(
                _code(payload.get("phevTotalUnit"), "phevTotalUnit", (0, 1, 2, 3))
            )
        return DistanceResponse(value, unit, raw_time, observed, received_at, total, total_unit)
    soc = _number(payload.get("soc"), "soc", 100)
    if kind == "battery":
        return BatteryResponse(soc, raw_time, observed, received_at)
    plugin = _code(payload.get("batteryPlugin"), "batteryPlugin", (0, 1, 2))
    charging = _boolean(payload.get("batteryCharge"), "batteryCharge")
    remain = payload.get("remainTime")
    if not isinstance(remain, dict):
        raise SchemaError("remainTime:expected_object")
    remain_value = _number(remain.get("value"), "remainTime.value")
    remain_unit = TimeUnit(_code(remain.get("unit"), "remainTime.unit", (0, 1, 2, 3)))
    target = None
    if "targetSOC" in payload:
        raw = payload["targetSOC"]
        if not isinstance(raw, dict) or not any(
            key in raw for key in ("plugType", "targetSOClevel")
        ):
            raise SchemaError("targetSOC:expected_nonempty_object")
        plug = (
            _code(raw["plugType"], "targetSOC.plugType", (0, 1, 2)) if "plugType" in raw else None
        )
        level = (
            _number(raw["targetSOClevel"], "targetSOC.targetSOClevel", 100)
            if "targetSOClevel" in raw
            else None
        )
        target = TargetSoc(plug, level)
    return ChargingResponse(
        plugin, charging, soc, remain_value, remain_unit, raw_time, observed, received_at, target
    )
