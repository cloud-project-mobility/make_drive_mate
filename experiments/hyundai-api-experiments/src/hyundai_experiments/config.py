"""Load only the selected local .env; never discover parent files or mutate os.environ."""

import re
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import dotenv_values

VARIABLES = (
    "HYUNDAI_SAMPLE_TOKEN",
    "HYUNDAI_SAMPLE_CAR_ID",
    "HYUNDAI_CLIENT_ID",
    "HYUNDAI_CLIENT_SECRET",
    "HYUNDAI_REDIRECT_URI",
)
PROJECT_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True, repr=False)
class Settings:
    sample_token: str = field(default="", repr=False)
    sample_car_id: str = field(default="", repr=False)
    client_id: str = field(default="", repr=False)
    client_secret: str = field(default="", repr=False)
    redirect_uri: str = field(default="", repr=False)

    @classmethod
    def from_env_file(cls, path: Path | None = None) -> "Settings":
        values = dotenv_values(
            path or PROJECT_ROOT / ".env", encoding="utf-8-sig", interpolate=False
        )
        return cls(*(str(values.get(key) or "").strip() for key in VARIABLES))

    def problems(self) -> tuple[str, ...]:
        issues = []
        if not self.sample_token:
            issues.append("HYUNDAI_SAMPLE_TOKEN:missing")
        elif not re.fullmatch(r"[A-Za-z0-9._~+/=-]+", self.sample_token):
            issues.append("HYUNDAI_SAMPLE_TOKEN:invalid_format")
        if not self.sample_car_id:
            issues.append("HYUNDAI_SAMPLE_CAR_ID:missing")
        elif not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", self.sample_car_id):
            issues.append("HYUNDAI_SAMPLE_CAR_ID:invalid_path_segment")
        return tuple(issues)

    def sensitive_values(self) -> tuple[str, ...]:
        return tuple(
            value
            for value in (
                self.sample_token,
                self.sample_car_id,
                self.client_id,
                self.client_secret,
                self.redirect_uri,
            )
            if value
        )
