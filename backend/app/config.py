"""Explicit server settings; never load a .env file or search for credentials."""

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal


@dataclass(frozen=True)
class Settings:
    database_path: Path = Path("data/drivemate.sqlite3")
    provider_mode: Literal["mock", "disconnected", "live"] = "mock"
    session_hours: int = 12
    cors_origins: tuple[str, ...] = (
        "http://localhost:8081",
        "http://127.0.0.1:8081",
        "http://localhost:19006",
        "http://127.0.0.1:19006",
    )
    max_body_bytes: int = 5 * 1024 * 1024 + 4096
    kakao_rest_key: str | None = None
    kakao_mobility_key: str | None = None
    google_client_id: str | None = None
    google_client_secret: str | None = None
    google_redirect_uri: str | None = None
    token_encryption_key: str | None = None

    @classmethod
    def from_env(cls) -> "Settings":
        mode = os.environ.get("DRIVEMATE_PROVIDER_MODE", "mock")
        if mode not in {"mock", "disconnected", "live"}:
            raise ValueError("DRIVEMATE_PROVIDER_MODE must be mock, disconnected or live")
        origins = os.environ.get("DRIVEMATE_CORS_ORIGINS")
        return cls(
            database_path=Path(os.environ.get("DRIVEMATE_DATABASE", "data/drivemate.sqlite3")),
            provider_mode=mode,
            kakao_rest_key=os.environ.get("DRIVEMATE_KAKAO_REST_KEY") if mode == "live" else None,
            kakao_mobility_key=os.environ.get("DRIVEMATE_KAKAO_MOBILITY_KEY")
            if mode == "live"
            else None,
            google_client_id=os.environ.get("DRIVEMATE_GOOGLE_CLIENT_ID")
            if mode == "live"
            else None,
            google_client_secret=os.environ.get("DRIVEMATE_GOOGLE_CLIENT_SECRET")
            if mode == "live"
            else None,
            google_redirect_uri=os.environ.get("DRIVEMATE_GOOGLE_REDIRECT_URI")
            if mode == "live"
            else None,
            token_encryption_key=os.environ.get("DRIVEMATE_TOKEN_ENCRYPTION_KEY")
            if mode == "live"
            else None,
            cors_origins=tuple(x.strip() for x in origins.split(",") if x.strip())
            if origins is not None
            else cls.cors_origins,
        )
