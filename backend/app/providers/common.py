"""Explicit provider modes; no environment, credential files, or implicit retries."""

from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Any, Literal

import httpx

ProviderMode = Literal["disconnected", "mock", "live"]


class ProviderError(Exception):
    """Safe public error: never include provider response bodies or request headers."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        http_status: int = 502,
        retryable: bool = False,
        retry_after_s: float | None = None,
        upstream_status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.retryable = retryable
        self.retry_after_s = retry_after_s
        self.upstream_status = upstream_status


def require_text(value: Any, *, maximum: int = 200, empty: bool = False) -> str:
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError("invalid text")
    if not empty and not value.strip():
        raise ValueError("empty text")
    return value.strip()


def nonnegative_number(value: Any) -> float | int:
    if type(value) not in (float, int) or not math.isfinite(value) or value < 0:
        raise ValueError("invalid numeric metric")
    return value


def nonnegative_int(value: Any) -> int:
    if type(value) is not int or value < 0:
        raise ValueError("invalid integer metric")
    return value


def aware_datetime(value: datetime) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timezone-aware datetime required")
    return value


class Provider:
    name = "provider"

    def __init__(
        self,
        mode: ProviderMode = "disconnected",
        *,
        transport: httpx.BaseTransport | None = None,
        timeout_s: float = 10.0,
    ) -> None:
        if mode not in {"disconnected", "mock", "live"}:
            raise ValueError("mode must be disconnected, mock, or live")
        if type(timeout_s) not in (int, float) or not math.isfinite(timeout_s) or timeout_s <= 0:
            raise ValueError("positive finite timeout required")
        self.mode = mode
        self.transport = transport
        self.timeout_s = timeout_s

    @property
    def is_mock(self) -> bool:
        # Injected transports are verification evidence, never live-provider evidence.
        return self.mode == "mock" or self.transport is not None

    def metadata(self) -> dict:
        return {
            "source": "mock" if self.is_mock else "live",
            "provider": self.name,
            "is_mock": self.is_mock,
            "mode": self.mode,
        }

    def require_enabled(self) -> None:
        if self.mode == "disconnected":
            raise ProviderError(
                "provider_disconnected", "외부 서비스가 연결되지 않았습니다.", http_status=503
            )

    def credential(self, value: str | None) -> str | None:
        self.require_enabled()
        if self.mode == "mock":
            return None
        if not isinstance(value, str) or not value:
            raise ProviderError(
                "provider_not_configured", "외부 서비스 인증 설정이 필요합니다.", http_status=503
            )
        if not value.isascii() or any(
            char.isspace() or ord(char) < 32 or ord(char) == 127 for char in value
        ):
            raise ProviderError(
                "provider_not_configured", "외부 서비스 인증 설정을 확인해 주세요.", http_status=503
            )
        return value

    def get_json(self, url: str, *, params: dict, headers: dict | None = None) -> dict:
        self.require_enabled()
        # Mock mode cannot accidentally open a socket if a fixture is not implemented.
        if self.mode == "mock" and self.transport is None:
            raise ProviderError(
                "mock_unavailable", "지원하지 않는 예시 요청입니다.", http_status=422
            )
        try:
            with httpx.Client(
                transport=self.transport,
                timeout=httpx.Timeout(self.timeout_s, connect=min(5.0, self.timeout_s)),
                follow_redirects=False,
                trust_env=False,
            ) as client:
                response = client.get(url, params=params, headers=headers)
        except httpx.TimeoutException:
            raise ProviderError(
                "provider_timeout",
                "외부 서비스 응답 시간이 초과되었습니다.",
                http_status=504,
                retryable=True,
            ) from None
        except httpx.TransportError:
            raise ProviderError(
                "provider_unavailable", "외부 서비스에 연결할 수 없습니다.", retryable=True
            ) from None
        if response.status_code == 429:
            retry_after = None
            try:
                candidate = float(response.headers.get("Retry-After", ""))
                if math.isfinite(candidate) and candidate >= 0:
                    retry_after = min(candidate, 120.0)
            except ValueError:
                pass
            raise ProviderError(
                "provider_rate_limited",
                "외부 서비스 요청 한도를 초과했습니다.",
                http_status=429,
                retryable=True,
                retry_after_s=retry_after,
            )
        if response.status_code in {401, 403}:
            raise ProviderError(
                "provider_authorization_required",
                "외부 서비스 연결 권한을 다시 확인해 주세요.",
                http_status=503,
                upstream_status=response.status_code,
            )
        if not response.is_success:
            raise ProviderError(
                "provider_http_error",
                "외부 서비스가 정상 응답을 반환하지 않았습니다.",
                retryable=response.status_code >= 500,
            )
        try:
            if len(response.content) > 2_000_000:
                raise ValueError("response too large")
            data = response.json()
            if not isinstance(data, dict):
                raise ValueError("object required")
        except (ValueError, UnicodeError):
            raise self.malformed() from None
        if any(key in data for key in ("error", "errors", "errCode", "errMsg", "errId")):
            raise ProviderError("provider_rejected", "외부 서비스가 요청을 거부했습니다.")
        return data

    def malformed(self) -> ProviderError:
        return ProviderError(
            "provider_malformed_response", "외부 서비스 응답 형식을 확인할 수 없습니다."
        )

    @staticmethod
    def now() -> str:
        return datetime.now(UTC).isoformat()
