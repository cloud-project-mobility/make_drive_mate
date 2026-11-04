import base64
import hashlib
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.providers import GoogleCalendarProvider
from app.providers.google_oauth import CALENDAR_SCOPE, GoogleOAuthClient


@pytest.fixture
def oauth_app(tmp_path):
    requests = []
    response_overrides = {}

    def handler(request):
        requests.append(request)
        form = parse_qs(request.content.decode())
        if request.url.path == "/revoke":
            return httpx.Response(200)
        if "error" in response_overrides:
            return httpx.Response(400, json={"error": response_overrides["error"]})
        payload = {
            "access_token": "synthetic-google-access",
            "expires_in": 3600,
            "scope": CALENDAR_SCOPE,
            "token_type": "Bearer",
        }
        if form.get("grant_type") == ["authorization_code"] and not response_overrides.get(
            "no_refresh"
        ):
            payload["refresh_token"] = "synthetic-google-refresh"
        payload.update(response_overrides.get("payload", {}))
        return httpx.Response(200, json=payload)

    settings = Settings(
        database_path=tmp_path / "oauth.sqlite3",
        provider_mode="live",
        google_client_id="synthetic-client",
        google_client_secret="synthetic-secret",
        google_redirect_uri="http://127.0.0.1:18085/api/v1/integrations/google/callback",
        token_encryption_key=Fernet.generate_key().decode(),
    )
    oauth = GoogleOAuthClient(
        settings.google_client_id,
        settings.google_client_secret,
        settings.google_redirect_uri,
        transport=httpx.MockTransport(handler),
    )
    app = create_app(
        settings, oauth=oauth, calendar_factory=lambda token: GoogleCalendarProvider(mode="mock")
    )
    with TestClient(app) as client:
        yield client, requests, response_overrides


def account(client, email="student@example.test"):
    response = client.post(
        "/api/v1/auth/register", json={"email": email, "password": "test-password-123"}
    )
    assert response.status_code == 201
    return {"Authorization": "Bearer " + response.json()["access_token"]}, response.json()["user"][
        "id"
    ]


def authorize(client, auth):
    response = client.post("/api/v1/integrations/google/authorize", headers=auth)
    assert response.status_code == 200, response.text
    url = urlsplit(response.json()["authorization_url"])
    assert url.netloc == "accounts.google.com"
    return parse_qs(url.query)


def callback(client, state, **params):
    return client.get("/api/v1/integrations/google/callback", params={"state": state, **params})


def test_complete_oauth_flow_pkce_encrypted_tokens_and_account_isolation(oauth_app):
    client, requests, _ = oauth_app
    auth, uid = account(client)
    other, _ = account(client, "other@example.test")
    assert client.get("/api/v1/calendar/events", headers=auth).status_code == 409
    query = authorize(client, auth)
    assert query["scope"] == [CALENDAR_SCOPE]
    state = query["state"][0]
    response = callback(client, state, code="synthetic-code")
    assert response.status_code == 200, response.text
    assert "synthetic-google-access" not in response.text
    form = parse_qs(requests[-1].content.decode())
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(form["code_verifier"][0].encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    assert query["code_challenge"] == [challenge]
    with client.app.state.store.connection() as con:
        encrypted = con.execute(
            "SELECT encrypted FROM provider_tokens WHERE user_id = ?", (uid,)
        ).fetchone()[0]
        assert b"synthetic-google-access" not in encrypted
        assert b"synthetic-google-refresh" not in encrypted
    assert client.get("/api/v1/integrations", headers=auth).json()["providers"]["google_calendar"][
        "connected"
    ]
    assert not client.get("/api/v1/integrations", headers=other).json()["providers"][
        "google_calendar"
    ]["connected"]
    assert client.get("/api/v1/calendar/events", headers=auth).status_code == 200
    assert client.get("/api/v1/calendar/events", headers=other).status_code == 409
    assert callback(client, state, code="replay-code").status_code == 400
    assert len(requests) == 1


def test_denial_expired_state_and_invalid_callback_do_not_send_request(oauth_app):
    client, requests, _ = oauth_app
    auth, _ = account(client)
    denied = authorize(client, auth)["state"][0]
    assert callback(client, denied, error="access_denied").status_code == 400
    assert callback(client, denied, code="replay").status_code == 400
    expired = authorize(client, auth)["state"][0]
    with client.app.state.store.connection() as con:
        con.execute("UPDATE oauth_states SET expires_at = 0")
    assert callback(client, expired, code="expired").status_code == 400
    invalid = authorize(client, auth)["state"][0]
    assert callback(client, invalid, code="contains spaces").status_code == 422
    assert requests == []


def expire_access(client, uid, **updates):
    integration = client.app.state.google
    with client.app.state.store.connection() as con:
        encrypted = con.execute(
            "SELECT encrypted FROM provider_tokens WHERE user_id = ?", (uid,)
        ).fetchone()[0]
        tokens = integration.decode(encrypted)
        tokens["expires_at"] = (datetime.now(UTC) - timedelta(seconds=10)).isoformat()
        tokens.update(updates)
        con.execute(
            "UPDATE provider_tokens SET encrypted = ? WHERE user_id = ?",
            (integration.encode(tokens), uid),
        )


def test_refresh_preserves_refresh_token_and_expiry(oauth_app):
    client, requests, _ = oauth_app
    auth, uid = account(client)
    assert (
        callback(client, authorize(client, auth)["state"][0], code="synthetic-code").status_code
        == 200
    )
    refresh_expiry = (datetime.now(UTC) + timedelta(days=6)).isoformat()
    expire_access(client, uid, refresh_token_expires_at=refresh_expiry)
    assert client.get("/api/v1/calendar/events", headers=auth).status_code == 200
    assert parse_qs(requests[-1].content.decode())["grant_type"] == ["refresh_token"]
    with client.app.state.store.connection() as con:
        encrypted = con.execute(
            "SELECT encrypted FROM provider_tokens WHERE user_id = ?", (uid,)
        ).fetchone()[0]
    saved = client.app.state.google.decode(encrypted)
    assert saved["refresh_token"] == "synthetic-google-refresh"
    assert saved["refresh_token_expires_at"] == refresh_expiry


def test_revoked_refresh_requires_new_consent(oauth_app):
    client, _, overrides = oauth_app
    auth, uid = account(client)
    assert (
        callback(client, authorize(client, auth)["state"][0], code="synthetic-code").status_code
        == 200
    )
    expire_access(client, uid)
    overrides["error"] = "invalid_grant"
    response = client.get("/api/v1/calendar/events", headers=auth)
    assert response.status_code >= 400
    assert response.json()["error"]["code"] == "oauth_reauthorization_required"
    assert not client.get("/api/v1/integrations", headers=auth).json()["providers"][
        "google_calendar"
    ]["connected"]


def test_disconnect_revokes_and_removes_pending_consent(oauth_app):
    client, requests, _ = oauth_app
    auth, _ = account(client)
    assert (
        callback(client, authorize(client, auth)["state"][0], code="synthetic-code").status_code
        == 200
    )
    pending = authorize(client, auth)["state"][0]
    response = client.delete("/api/v1/integrations/google", headers=auth)
    assert response.json() == {"connected": False, "provider_revoked": True}
    assert requests[-1].url.path == "/revoke"
    assert callback(client, pending, code="late-code").status_code == 400
    assert client.get("/api/v1/calendar/events", headers=auth).status_code == 409


def test_account_deletion_removes_google_tokens(oauth_app):
    client, _, _ = oauth_app
    auth, _ = account(client)
    assert (
        callback(client, authorize(client, auth)["state"][0], code="synthetic-code").status_code
        == 200
    )
    assert client.delete("/api/v1/account", headers=auth).status_code == 200
    with client.app.state.store.connection() as con:
        assert con.execute("SELECT COUNT(*) FROM provider_tokens").fetchone()[0] == 0
        assert con.execute("SELECT COUNT(*) FROM oauth_states").fetchone()[0] == 0


def test_mock_mode_never_starts_real_consent(tmp_path):
    with TestClient(create_app(Settings(database_path=tmp_path / "db"))) as client:
        auth, _ = account(client)
        response = client.post("/api/v1/integrations/google/authorize", headers=auth)
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "oauth_not_configured"
