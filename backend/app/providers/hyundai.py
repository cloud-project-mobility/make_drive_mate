"""Synthetic Hyundai adapter, with raw units and timestamps preserved.

Field validation is adapted from cloud-project-mobility/
hyundai_devloper_api_experiments models.py and CONTRACT_AND_SECURITY.md.
Real vehicle OAuth, data permission, and provider timezone remain unverified;
this adapter deliberately has no live-network path or odometer write operation.
"""

from __future__ import annotations

import math
import re
from datetime import UTC, datetime
from decimal import Decimal

from .common import Provider, ProviderError, nonnegative_number, require_text

DISTANCE_UNITS = {
    0: ("feet", Decimal("0.0003048")),
    1: ("km", Decimal("1")),
    2: ("metres", Decimal("0.001")),
    3: ("miles", Decimal("1.609344")),
}
WARNING_NAMES = (
    "engine_oil",
    "tire_pressure",
    "brake_oil",
    "low_fuel",
    "washer_fluid",
    "smart_key_battery",
)


def normalize_odometer(payload: object, received_at: datetime) -> dict:
    """Parse without persisting or treating an absolute reading as trip distance."""
    try:
        if not isinstance(payload, dict) or any(
            key in payload for key in ("error", "errors", "errCode", "errMsg", "errId")
        ):
            raise ValueError("invalid envelope")
        require_text(payload["msgId"], maximum=1024)
        if received_at.tzinfo is None or received_at.utcoffset() is None:
            raise ValueError("received time needs offset")
        rows = payload["odometers"]
        if not isinstance(rows, list) or not rows:
            raise ValueError("nonempty odometer array required")
        readings = []
        for row in rows:
            day, timestamp = row["date"], row["timestamp"]
            if (
                not isinstance(day, str)
                or not re.fullmatch(r"[0-9]{8}", day)
                or not isinstance(timestamp, str)
                or not re.fullmatch(r"[0-9]{14}", timestamp)
            ):
                raise ValueError("invalid provider timestamp")
            datetime.strptime(day, "%Y%m%d")
            observed = datetime.strptime(timestamp, "%Y%m%d%H%M%S")
            value, unit = nonnegative_number(row["value"]), row["unit"]
            if type(unit) is not int or unit not in DISTANCE_UNITS:
                raise ValueError("unknown distance unit")
            unit_name, to_km = DISTANCE_UNITS[unit]
            value_km = float(Decimal(str(value)) * to_km)
            if not math.isfinite(value_km):
                raise ValueError("converted distance is outside numeric range")
            readings.append(
                {
                    "value": str(Decimal(str(value))),
                    "unit_code": unit,
                    "unit": unit_name,
                    "value_km": value_km,
                    "query_date_raw": day,
                    "provider_timestamp_raw": timestamp,
                    "provider_observed_at_local": observed.isoformat(),
                    "provider_timezone": None,
                }
            )
        latest = max(readings, key=lambda reading: reading["provider_timestamp_raw"])
        return {
            "odometer_km": latest["value_km"],
            "odometer_readings": readings,
            "observed_at": None,
            "provider_timestamp_raw": latest["provider_timestamp_raw"],
            "provider_timezone": None,
            "received_at": received_at.isoformat(),
            "odometer_policy": "absolute_provider_reading_do_not_add_trip_distance",
        }
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
        raise ProviderError(
            "provider_malformed_response", "차량 누적거리 응답 형식을 확인할 수 없습니다."
        ) from None


class HyundaiProvider(Provider):
    name = "hyundai"

    def vehicle_status(self, vehicle_id: str = "mock-vehicle", *, powertrain: str = "EV") -> dict:
        require_text(vehicle_id, maximum=200)
        if powertrain not in {"EV", "ICE", "HYB", "HYBRID", "PHEV"}:
            raise ValueError("unsupported powertrain")
        self.require_enabled()
        if self.mode != "mock":
            raise ProviderError(
                "provider_not_configured",
                "현대 실차 연결은 차량 인증·동의와 데이터 계약 확인 후 사용할 수 있습니다.",
                http_status=503,
            )
        received_at = datetime.now(UTC)
        result = normalize_odometer(
            {
                "msgId": "synthetic-drivemate-status",
                "odometers": [
                    {"date": "20261028", "timestamp": "20261028090000", "value": 12500, "unit": 1}
                ],
            },
            received_at,
        )
        return {
            **self.metadata(),
            **result,
            "range_km": 280 if powertrain in {"EV", "PHEV"} else 420,
            "range_raw": {
                "value": 280 if powertrain in {"EV", "PHEV"} else 420,
                "unit_code": 1,
                "unit": "km",
                "provider_timestamp_raw": "20261028090000",
                "provider_timezone": None,
            },
            "battery_percent": 72 if powertrain in {"EV", "PHEV"} else None,
            "warnings": {name: False for name in WARNING_NAMES},
            "warnings_observed_at": None,
            "freshness": "unknown",
            "vehicle_id": vehicle_id,
            "notice": (
                "직접 만든 예시 차량 상태입니다. "
                "실차 정보가 아니며 누적 주행거리에 자동 합산하지 않습니다."
            ),
        }
