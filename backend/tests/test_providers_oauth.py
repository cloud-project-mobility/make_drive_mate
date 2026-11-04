import base64
import hashlib
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from app.providers import CALENDAR_SCOPE, GoogleOAuthClient, ProviderError

NOW = datetime(2026, 10, 28, 0, 0, tzinfo=UTC)
VERIFIER = "synthetic-test-verifier-" + "a" * 40
CHALLENGE = (
    base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).decode().rstrip("=")
)
STATE = "synthetic-state-" + "b" * 32
CLIENT_ID = "synthetic-client.apps.googleusercontent.com"
CLIENT_SECRET = "synthetic-client-secret"
REDIRECT = "http://localhost:8000/api/integrations/google/callback"


def tokens(**overrides):
    return {
        "access_token": "synthetic-access-token",
        "refresh_token": "synthetic-refresh-token",
        "expires_in": 3600,
        "token_type": "Bearer",
        "scope": CALENDAR_SCOPE,
        **overrides,
    }


def client(handler=None, **overrides):
    arguments = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "redirect_uri": REDIRECT,
        "transport": httpx.MockTransport(
            handler or (lambda request: httpx.Response(200, json=tokens()))
        ),
        "clock": lambda: NOW,
    }
    arguments.update(overrides)
    return GoogleOAuthClient(**arguments)


def test_authorization_url_requires_pkce_state_minimal_scope_and_offline_consent():
    oauth = client()
    url = urlsplit(oauth.authorization_url(STATE, CHALLENGE))
    assert url.scheme == "https" and url.netloc == "accounts.google.com"
    assert url.path == "/o/oauth2/v2/auth"
    query = parse_qs(url.query)
    assert query == {
        "client_id": [CLIENT_ID],
        "redirect_uri": [REDIRECT],
        "response_type": ["code"],
        "scope": [CALENDAR_SCOPE],
        "state": [STATE],
        "code_challenge": [CHALLENGE],
        "code_challenge_method": ["S256"],
        "access_type": ["offline"],
        "prompt": ["consent"],
        "include_granted_scopes": ["false"],
    }
    assert CLIENT_SECRET not in oauth.authorization_url(STATE, CHALLENGE)
    assert CLIENT_SECRET not in repr(oauth)
    assert oauth.configured and oauth.source == "mock"


@pytest.mark.parametrize(
    "override",
    [
        {"client_id": None},
        {"client_secret": None},
        {"redirect_uri": None},
        {"client_secret": "invalid\nsecret"},
        {"redirect_uri": "http://example.test/callback"},
        {"redirect_uri": "https://user:password@example.test/callback"},
        {"redirect_uri": "https://example.test/callback#fragment"},
        {"redirect_uri": "https://example.test:99999/callback"},
        {"redirect_uri": "https://example.test\\@other.test/callback"},
    ],
)
def test_invalid_configuration_never_starts_network(override):
    def forbidden(request):
        pytest.fail("unconfigured OAuth attempted a request")

    oauth = client(forbidden, **override)
    assert not oauth.configured
    for operation in (
        lambda: oauth.authorization_url(STATE, CHALLENGE),
        lambda: oauth.exchange("synthetic-code", VERIFIER),
        lambda: oauth.refresh("synthetic-refresh"),
        lambda: oauth.revoke("synthetic-refresh"),
    ):
        with pytest.raises(ProviderError) as error:
            operation()
        assert error.value.code == "oauth_not_configured"


@pytest.mark.parametrize(
    "state,challenge",
    [("short", CHALLENGE), (STATE, "short"), (STATE, "x" * 43 + "="), ("x" * 32 + "\n", CHALLENGE)],
)
def test_invalid_state_or_pkce_challenge_is_rejected(state, challenge):
    with pytest.raises(ValueError):
        client().authorization_url(state, challenge)


def test_exchange_sends_secrets_only_in_fixed_https_form_and_conservative_expiry():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=tokens(refresh_token_expires_in=7200))

    result = client(handler).exchange("synthetic-code/+", VERIFIER)
    request = requests[0]
    assert str(request.url) == "https://oauth2.googleapis.com/token"
    assert request.method == "POST"
    assert request.headers["content-type"] == "application/x-www-form-urlencoded"
    assert parse_qs(request.content.decode()) == {
        "client_id": [CLIENT_ID],
        "client_secret": [CLIENT_SECRET],
        "redirect_uri": [REDIRECT],
        "grant_type": ["authorization_code"],
        "code": ["synthetic-code/+"],
        "code_verifier": [VERIFIER],
    }
    assert result["expires_at"] == (NOW + timedelta(hours=1)).isoformat()
    assert result["refresh_token_expires_at"] == (NOW + timedelta(hours=2)).isoformat()
    assert result["source"] == "mock"
    assert len(requests) == 1


def test_refresh_inherits_only_verified_scope_and_does_not_invent_rotated_token():
    requests = []
    payload = tokens(token_type="bearer")
    del payload["scope"]
    del payload["refresh_token"]

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=payload)

    oauth = client(handler)
    result = oauth.refresh("previous-refresh-token", granted_scope=CALENDAR_SCOPE)
    assert result["refresh_token"] is None
    assert result["token_type"] == "Bearer" and result["scope"] == CALENDAR_SCOPE
    assert parse_qs(requests[0].content.decode()) == {
        "client_id": [CLIENT_ID],
        "client_secret": [CLIENT_SECRET],
        "refresh_token": ["previous-refresh-token"],
        "grant_type": ["refresh_token"],
    }
    with pytest.raises(ProviderError) as error:
        oauth.refresh("previous-refresh-token", granted_scope="openid")
    assert error.value.code == "oauth_scope_mismatch" and len(requests) == 1


def test_refresh_rotation_is_returned_for_encrypted_storage():
    result = client(
        lambda request: httpx.Response(200, json=tokens(refresh_token="rotated-refresh"))
    ).refresh("old-refresh")
    assert result["refresh_token"] == "rotated-refresh"


@pytest.mark.parametrize(
    "scope",
    [
        "openid",
        CALENDAR_SCOPE + " openid",
        "https://www.googleapis.com/auth/calendar.readonly",
        None,
        CALENDAR_SCOPE + " " + CALENDAR_SCOPE,
    ],
)
def test_exchange_rejects_missing_broader_or_different_scope(scope):
    payload = tokens(scope=scope)
    if scope is None:
        del payload["scope"]
    with pytest.raises(ProviderError) as error:
        client(lambda request: httpx.Response(200, json=payload)).exchange(
            "synthetic-code", VERIFIER
        )
    assert error.value.code == "oauth_scope_mismatch"


@pytest.mark.parametrize(
    "overrides",
    [
        {"expires_in": True},
        {"expires_in": 0},
        {"expires_in": -1},
        {"expires_in": "3600"},
        {"expires_in": 2**100},
        {"token_type": "DPoP"},
        {"access_token": "bad\ntoken"},
        {"refresh_token": None},
        {"refresh_token_expires_in": False},
        {"refresh_token_expires_in": 0},
        {"refresh_token_expires_in": 2**100},
    ],
)
def test_malformed_tokens_and_lifetimes_fail(overrides):
    with pytest.raises(ProviderError) as error:
        client(lambda request: httpx.Response(200, json=tokens(**overrides))).exchange(
            "synthetic-code", VERIFIER
        )
    assert error.value.code == "provider_malformed_response"


def test_expiry_accounts_for_network_elapsed_time():
    instants = iter((NOW, NOW + timedelta(seconds=3601)))
    with pytest.raises(ProviderError) as error:
        client(clock=lambda: next(instants)).exchange("synthetic-code", VERIFIER)
    assert error.value.code == "provider_malformed_response"


@pytest.mark.parametrize(
    "status,payload,code",
    [
        (
            400,
            {"error": "invalid_grant", "error_description": "secret-response"},
            "oauth_reauthorization_required",
        ),
        (
            400,
            {"error": "invalid_client", "error_description": "secret-response"},
            "oauth_not_configured",
        ),
        (
            400,
            {"error": "unknown-error", "error_description": "secret-response"},
            "provider_rejected",
        ),
        (200, {"error": {"message": "secret-response"}}, "provider_rejected"),
        (429, {"secret": "secret-response"}, "provider_rate_limited"),
        (500, {"secret": "secret-response"}, "provider_http_error"),
        (302, {}, "provider_rejected"),
    ],
)
def test_oauth_errors_are_safe_and_not_retried_or_redirected(status, payload, code):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(status, json=payload, headers={"Location": "https://other.invalid/"})

    with pytest.raises(ProviderError) as error:
        client(handler).exchange("synthetic-code", VERIFIER)
    assert error.value.code == code
    assert "secret-response" not in str(error.value)
    assert len(calls) == 1


@pytest.mark.parametrize(
    "failure,code",
    [
        (httpx.ReadTimeout("sensitive"), "provider_timeout"),
        (httpx.ConnectError("sensitive"), "provider_unavailable"),
    ],
)
def test_oauth_transport_failures_hide_exception_text(failure, code):
    def handler(request):
        raise failure

    with pytest.raises(ProviderError) as error:
        client(handler).refresh("synthetic-refresh")
    assert error.value.code == code and "sensitive" not in str(error.value)


@pytest.mark.parametrize("content", [b"invalid json", b"[]", b"{}", b""])
def test_invalid_or_empty_token_response_fails(content):
    with pytest.raises(ProviderError) as error:
        client(lambda request: httpx.Response(200, content=content)).exchange(
            "synthetic-code", VERIFIER
        )
    assert error.value.code == "provider_malformed_response"


def test_revocation_uses_form_body_and_accepts_empty_success():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200)

    assert client(handler).revoke("synthetic-refresh") is None
    request = calls[0]
    assert str(request.url) == "https://oauth2.googleapis.com/revoke"
    assert parse_qs(request.content.decode()) == {"token": ["synthetic-refresh"]}
    assert len(calls) == 1


def test_revoked_or_expired_refresh_token_requires_reauthorization():
    oauth = client(lambda request: httpx.Response(400, json={"error": "invalid_grant"}))
    with pytest.raises(ProviderError) as error:
        oauth.refresh("expired-refresh")
    assert error.value.code == "oauth_reauthorization_required"


@pytest.mark.parametrize("verifier", ["short", "x" * 129, "x" * 43 + "=", "x" * 43 + "\n"])
def test_exchange_rejects_invalid_pkce_verifier(verifier):
    with pytest.raises(ValueError):
        client().exchange("synthetic-code", verifier)
