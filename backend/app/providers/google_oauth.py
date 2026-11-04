"""Server-side Google Calendar consent boundary, with no ambient credentials.

Protocol references reviewed 2026-10-28:
https://developers.google.com/identity/protocols/oauth2/web-server
https://developers.google.com/identity/protocols/oauth2/native-app (PKCE)
https://developers.google.com/identity/protocols/oauth2/resources/best-practices

The application owns per-user, one-use state verification and encrypted token
storage. This class never logs, persists, or returns tokens to a browser. Calling
refresh presupposes a previously verified Calendar-only grant from exchange.
Live Google authorization and account consent are not verified by mock tests.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode, urlsplit

import httpx

from .common import ProviderError, aware_datetime

CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly"
AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOCATION_URL = "https://oauth2.googleapis.com/revoke"


def _secret(value: object, *, maximum: int = 16384) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= maximum
        or not value.isascii()
        or any(not 33 <= ord(character) <= 126 for character in value)
    ):
        raise ValueError("invalid OAuth value")
    return value


class GoogleOAuthClient:
    def __init__(
        self,
        client_id: str | None = None,
        client_secret: str | None = None,
        redirect_uri: str | None = None,
        *,
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], datetime] | None = None,
        timeout_s: float = 10.0,
    ) -> None:
        if type(timeout_s) not in (int, float) or not math.isfinite(timeout_s) or timeout_s <= 0:
            raise ValueError("positive finite timeout required")
        self._client_id = client_id
        self._client_secret = client_secret
        self._redirect_uri = redirect_uri
        self._transport = transport
        self._clock = clock or (lambda: datetime.now(UTC))
        self._timeout_s = timeout_s

    @property
    def is_mock(self) -> bool:
        return self._transport is not None

    @property
    def source(self) -> str:
        return "mock" if self.is_mock else "live"

    @property
    def configured(self) -> bool:
        try:
            self._configuration()
        except ProviderError:
            return False
        return True

    def _configuration(self) -> tuple[str, str, str]:
        try:
            client_id = _secret(self._client_id, maximum=1024)
            client_secret = _secret(self._client_secret, maximum=4096)
            redirect_uri = _secret(self._redirect_uri, maximum=2048)
            redirect = urlsplit(redirect_uri)
            if (
                not redirect.hostname
                or redirect.username is not None
                or redirect.password is not None
                or redirect.fragment
                or "\\" in redirect_uri
                or not (
                    redirect.scheme == "https"
                    or (
                        redirect.scheme == "http"
                        and redirect.hostname in {"localhost", "127.0.0.1", "::1"}
                    )
                )
            ):
                raise ValueError("invalid redirect URI")
            # Validate a malformed or out-of-range port before URL generation.
            _ = redirect.port
        except (ValueError, TypeError):
            raise ProviderError(
                "oauth_not_configured",
                "Google 캘린더 OAuth 서버 설정이 필요합니다.",
                http_status=503,
            ) from None
        return client_id, client_secret, redirect_uri

    def authorization_url(self, state: str, code_challenge: str) -> str:
        client_id, _, redirect_uri = self._configuration()
        if not isinstance(state, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", state):
            raise ValueError("invalid OAuth state")
        if not isinstance(code_challenge, str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{43}", code_challenge
        ):
            raise ValueError("invalid S256 code challenge")
        return (
            AUTHORIZATION_URL
            + "?"
            + urlencode(
                {
                    "client_id": client_id,
                    "redirect_uri": redirect_uri,
                    "response_type": "code",
                    "scope": CALENDAR_SCOPE,
                    "state": state,
                    "code_challenge": code_challenge,
                    "code_challenge_method": "S256",
                    "access_type": "offline",
                    "prompt": "consent",
                    "include_granted_scopes": "false",
                }
            )
        )

    def exchange(self, code: str, code_verifier: str) -> dict:
        client_id, client_secret, redirect_uri = self._configuration()
        _secret(code)
        if not isinstance(code_verifier, str) or not re.fullmatch(
            r"[A-Za-z0-9._~-]{43,128}", code_verifier
        ):
            raise ValueError("invalid PKCE code verifier")
        started_at = aware_datetime(self._clock()).astimezone(UTC)
        response = self._post(
            TOKEN_URL,
            {
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": code_verifier,
            },
        )
        return self._tokens(response, started_at=started_at, inherited_scope=None)

    def refresh(self, refresh_token: str, *, granted_scope: str = CALENDAR_SCOPE) -> dict:
        client_id, client_secret, _ = self._configuration()
        _secret(refresh_token)
        if granted_scope != CALENDAR_SCOPE:
            raise self._scope_error()
        started_at = aware_datetime(self._clock()).astimezone(UTC)
        response = self._post(
            TOKEN_URL,
            {
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            },
        )
        return self._tokens(response, started_at=started_at, inherited_scope=granted_scope)

    def revoke(self, token: str) -> None:
        self._configuration()
        _secret(token)
        # Keep tokens out of URL/query strings and intermediary access logs.
        self._post(REVOCATION_URL, {"token": token}, expect_json=False)

    def _post(self, url: str, data: dict, *, expect_json: bool = True) -> dict:
        if url not in {TOKEN_URL, REVOCATION_URL}:
            raise ValueError("OAuth endpoint is not allowed")
        try:
            with httpx.Client(
                transport=self._transport,
                timeout=httpx.Timeout(self._timeout_s, connect=min(5.0, self._timeout_s)),
                trust_env=False,
                follow_redirects=False,
            ) as client:
                response = client.post(url, data=data, headers={"Accept": "application/json"})
        except httpx.TimeoutException:
            raise ProviderError(
                "provider_timeout",
                "Google 연결 응답 시간이 초과되었습니다.",
                http_status=504,
                retryable=True,
            ) from None
        except httpx.TransportError:
            raise ProviderError(
                "provider_unavailable",
                "Google 연결 서버에 접근할 수 없습니다.",
                retryable=True,
            ) from None
        if response.status_code == 429:
            raise ProviderError(
                "provider_rate_limited",
                "Google 연결 요청 한도를 초과했습니다.",
                http_status=429,
                retryable=True,
            )
        if response.status_code >= 500:
            raise ProviderError(
                "provider_http_error",
                "Google 연결 서버가 정상 응답하지 않았습니다.",
                retryable=True,
            )
        # OAuth error text may contain a code/token; inspect only known error names.
        try:
            if len(response.content) > 128_000:
                raise ValueError("OAuth response too large")
            payload = response.json() if response.content else {}
        except (ValueError, UnicodeError):
            raise self._malformed() from None
        if not isinstance(payload, dict):
            raise self._malformed()
        error = payload.get("error")
        if error in ("invalid_grant", "access_denied", "invalid_token"):
            raise ProviderError(
                "oauth_reauthorization_required",
                "Google 캘린더 연결 동의가 다시 필요합니다.",
                http_status=401,
            )
        if error in ("invalid_client", "unauthorized_client", "redirect_uri_mismatch"):
            raise ProviderError(
                "oauth_not_configured",
                "Google 캘린더 OAuth 서버 설정을 확인해 주세요.",
                http_status=503,
            )
        if response.status_code != 200 or "error" in payload:
            raise ProviderError("provider_rejected", "Google 연결 요청을 완료하지 못했습니다.")
        if not expect_json:
            return {}
        return payload

    def _tokens(self, payload: dict, *, started_at: datetime, inherited_scope: str | None) -> dict:
        try:
            access_token = _secret(payload["access_token"])
            refresh_token = (
                _secret(payload["refresh_token"]) if "refresh_token" in payload else None
            )
            expires_in = payload["expires_in"]
            if type(expires_in) is not int or expires_in <= 0:
                raise ValueError("invalid access token lifetime")
            expires_at = started_at + timedelta(seconds=expires_in)
            if expires_at <= aware_datetime(self._clock()).astimezone(UTC):
                raise ValueError("token already expired")
            token_type = payload["token_type"]
            if not isinstance(token_type, str) or token_type.lower() != "bearer":
                raise ValueError("unsupported token type")
            scope = payload.get("scope", inherited_scope)
            if not isinstance(scope, str) or scope.split() != [CALENDAR_SCOPE]:
                raise self._scope_error()
            refresh_expires_at = None
            if "refresh_token_expires_in" in payload:
                refresh_expires_in = payload["refresh_token_expires_in"]
                if type(refresh_expires_in) is not int or refresh_expires_in <= 0:
                    raise ValueError("invalid refresh token lifetime")
                refresh_expires_at = started_at + timedelta(seconds=refresh_expires_in)
                if refresh_expires_at <= aware_datetime(self._clock()).astimezone(UTC):
                    raise ValueError("refresh token already expired")
            return {
                "access_token": access_token,
                "refresh_token": refresh_token,
                "expires_at": expires_at.isoformat(),
                "expires_in": expires_in,
                "scope": CALENDAR_SCOPE,
                "token_type": "Bearer",
                "refresh_token_expires_at": refresh_expires_at.isoformat()
                if refresh_expires_at
                else None,
                "source": self.source,
            }
        except (ValueError, KeyError, TypeError, OverflowError):
            raise self._malformed() from None

    @staticmethod
    def _scope_error() -> ProviderError:
        return ProviderError(
            "oauth_scope_mismatch",
            "캘린더 일정 읽기 권한만 승인된 연결이 필요합니다.",
            http_status=403,
        )

    @staticmethod
    def _malformed() -> ProviderError:
        return ProviderError(
            "provider_malformed_response", "Google 연결 응답 형식을 확인할 수 없습니다."
        )
