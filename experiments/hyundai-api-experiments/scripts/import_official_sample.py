"""Read the historical public Sample Test settings URL (404 on 2026-11-25).

This is a GET of published demo settings, not OAuth token issuance/refresh.
Only missing .env values are populated; credentials/vehicle IDs are never printed.
"""

import json
import os
import tempfile
from pathlib import Path

import httpx
from dotenv import set_key

from hyundai_experiments.config import PROJECT_ROOT, Settings
from hyundai_experiments.errors import transport_status

INFO_URL = "https://developers.hyundai.com/api/v1/sampleTest/getSampleTestInfo"
EXPECTED_DOMAIN = "https://dev.kr-ccapi.hyundai.com"


def main() -> int:
    path = PROJECT_ROOT / ".env"
    current = Settings.from_env_file(path)
    if current.sample_token and current.sample_car_id:
        print(json.dumps({"status": "existing_settings_preserved", "network_attempted": False}))
        return 0
    try:
        with httpx.Client(
            timeout=15, verify=True, trust_env=False, follow_redirects=False
        ) as client:
            response = client.get(INFO_URL, headers={"Accept": "application/json"})
        if response.status_code != 200:
            print(
                json.dumps(
                    {"status": "sample_info_unavailable", "http_status": response.status_code}
                )
            )
            return 1
        payload = response.json()
        if payload.get("result") != "OK":
            raise ValueError("Unexpected result")
        info = payload["data"]["contents"]
        if info["domain"].rstrip("/") != EXPECTED_DOMAIN:
            raise ValueError("Unexpected sample host")
        # Match the official Sample Test UI's default selection, not an invented ID.
        token, car = info["testToken"], info["carIdList"][0]["code"]
        if not isinstance(token, str) or not isinstance(car, str):
            raise ValueError("Unexpected settings types")
        candidate = Settings(current.sample_token or token, current.sample_car_id or car)
        if candidate.problems():
            raise ValueError("Invalid settings")
        # An atomic replacement preserves all existing content and nonempty values.
        original = path.read_text(encoding="utf-8-sig") if path.exists() else ""
        fd, temporary = tempfile.mkstemp(prefix=".env.", suffix=".tmp", dir=path.parent)
        staged = Path(temporary)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(original)
            if not current.sample_token:
                set_key(staged, "HYUNDAI_SAMPLE_TOKEN", token, quote_mode="always")
            if not current.sample_car_id:
                set_key(staged, "HYUNDAI_SAMPLE_CAR_ID", car, quote_mode="always")
            latest = path.read_text(encoding="utf-8-sig") if path.exists() else ""
            if latest != original:
                raise ValueError("Settings changed during import")
            os.replace(staged, path)
        finally:
            staged.unlink(missing_ok=True)
        print(
            json.dumps(
                {
                    "status": "public_sample_settings_imported",
                    "http_status": 200,
                    "stored_in": ".env",
                    "selected_vehicle": "official_ui_default",
                    "oauth_credentials_used": False,
                    "vehicle_data_requested": False,
                }
            )
        )
        return 0
    except httpx.RequestError as exc:
        print(
            json.dumps(
                {
                    "status": "sample_info_import_failed",
                    "error_category": transport_status(exc).value,
                    "details_redacted": True,
                }
            )
        )
        return 1
    except (
        ValueError,
        KeyError,
        IndexError,
        TypeError,
        AttributeError,
        OSError,
    ):
        print(json.dumps({"status": "sample_info_import_failed", "details_redacted": True}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
