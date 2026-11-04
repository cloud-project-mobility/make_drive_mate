"""Exercise the HTTP route through real adapters and injected Google transports."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.providers import GoogleCalendarProvider, GoogleOAuthClient
from app.providers.google_oauth import CALENDAR_SCOPE


@pytest.fixture
def recovery(tmp_path):
    control = {
        "calendar_status": None,
        "refresh_error": None,
        "block_calendar": False,
    }
    calls = {"refresh": [], "calendar": []}
    entered, release = Event(), Event()

    def oauth_handler(request):
        if request.url.path == "/revoke":
            return httpx.Response(200)
        form = parse_qs(request.content.decode())
        refreshed = form["grant_type"] == ["refresh_token"]
        if refreshed:
            calls["refresh"].append(form)
            if control["refresh_error"] == "timeout":
                raise httpx.ReadTimeout("synthetic timeout")
            if control["refresh_error"]:
                return httpx.Response(400, json={"error": control["refresh_error"]})
        return httpx.Response(
            200,
            json={
                "access_token": "synthetic-fresh" if refreshed else "synthetic-initial",
                "refresh_token": "synthetic-refresh",
                "expires_in": 3600,
                "token_type": "Bearer",
                "scope": CALENDAR_SCOPE,
            },
        )

    def calendar_handler(request):
        calls["calendar"].append(request.headers["Authorization"])
        if control["block_calendar"]:
            entered.set()
            assert release.wait(5)
        status = control["calendar_status"]
        if status is not None:
            if status == 200:
                return httpx.Response(200, json={"timeZone": "Asia/Seoul", "items": []})
            return httpx.Response(status, json={"error": {"message": "synthetic error"}})
        if request.headers["Authorization"] == "Bearer synthetic-initial":
            return httpx.Response(401, json={"error": {"message": "synthetic rejection"}})
        return httpx.Response(200, json={"timeZone": "Asia/Seoul", "items": []})

    settings = Settings(
        database_path=tmp_path / "recovery.sqlite3",
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
        transport=httpx.MockTransport(oauth_handler),
    )
    app = create_app(
        settings,
        oauth=oauth,
        calendar_factory=lambda token: GoogleCalendarProvider(
            "live", access_token=token, transport=httpx.MockTransport(calendar_handler)
        ),
    )
    with TestClient(app) as client:
        session = client.post(
            "/api/v1/auth/register",
            json={
                "email": "recovery@example.test",
                "password": "synthetic-password",
            },
        ).json()
        auth = {"Authorization": "Bearer " + session["access_token"]}
        url = client.post("/api/v1/integrations/google/authorize", headers=auth).json()[
            "authorization_url"
        ]
        state = parse_qs(urlsplit(url).query)["state"][0]
        assert (
            client.get(
                "/api/v1/integrations/google/callback",
                params={
                    "state": state,
                    "code": "synthetic-code",
                },
            ).status_code
            == 200
        )
        yield client, auth, control, calls, entered, release


def is_connected(client, auth):
    return client.get("/api/v1/integrations", headers=auth).json()["providers"]["google_calendar"][
        "connected"
    ]


def test_calendar_401_refreshes_unexpired_token_once_and_recovers(recovery):
    client, auth, _, calls, _, _ = recovery
    response = client.get("/api/v1/calendar/events", headers=auth)
    assert response.status_code == 200 and response.json()["events"] == []
    assert calls["calendar"] == ["Bearer synthetic-initial", "Bearer synthetic-fresh"]
    assert len(calls["refresh"]) == 1
    assert is_connected(client, auth)
    assert client.get("/api/v1/auth/me", headers=auth).status_code == 200


def test_calendar_rejecting_fresh_token_requires_consent_without_loop(recovery):
    client, auth, control, calls, _, _ = recovery
    control["calendar_status"] = 401
    response = client.get("/api/v1/calendar/events", headers=auth)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "oauth_reauthorization_required"
    assert len(calls["calendar"]) == 2 and len(calls["refresh"]) == 1
    assert not is_connected(client, auth)
    assert client.get("/api/v1/calendar/events", headers=auth).status_code == 409
    assert len(calls["calendar"]) == 2
    assert client.get("/api/v1/auth/me", headers=auth).status_code == 200


@pytest.mark.parametrize("status", [403, 429, 500])
def test_calendar_non401_never_discards_or_refreshes_grant(recovery, status):
    client, auth, control, calls, _, _ = recovery
    control["calendar_status"] = status
    response = client.get("/api/v1/calendar/events", headers=auth)
    assert response.status_code >= 400
    assert len(calls["calendar"]) == 1 and calls["refresh"] == []
    assert is_connected(client, auth)


def test_refresh_timeout_keeps_connection_for_retry(recovery):
    client, auth, control, calls, _, _ = recovery
    control["refresh_error"] = "timeout"
    response = client.get("/api/v1/calendar/events", headers=auth)
    assert response.status_code == 504
    assert is_connected(client, auth) and len(calls["calendar"]) == 1
    control["refresh_error"] = None
    assert client.get("/api/v1/calendar/events", headers=auth).status_code == 200


def test_invalid_refresh_grant_disconnects_and_preserves_local_session(recovery):
    client, auth, control, calls, _, _ = recovery
    control["refresh_error"] = "invalid_grant"
    response = client.get("/api/v1/calendar/events", headers=auth)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "oauth_reauthorization_required"
    assert len(calls["calendar"]) == len(calls["refresh"]) == 1
    assert not is_connected(client, auth)
    assert client.get("/api/v1/auth/me", headers=auth).status_code == 200


@pytest.mark.parametrize("remove_account", [False, True])
def test_pending_calendar_result_is_rejected_after_disconnect_or_account_removal(
    recovery, remove_account
):
    client, auth, control, calls, entered, release = recovery
    # A successful response is held until deletion commits.
    control["calendar_status"] = 200
    control["block_calendar"] = True
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(client.get, "/api/v1/calendar/events", headers=auth)
        try:
            assert entered.wait(5)
            endpoint = "/api/v1/account" if remove_account else "/api/v1/integrations/google"
            assert client.delete(endpoint, headers=auth).status_code == 200
        finally:
            release.set()
        response = pending.result(5)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "google_connection_changed"
    assert "events" not in response.json() and calls["refresh"] == []
