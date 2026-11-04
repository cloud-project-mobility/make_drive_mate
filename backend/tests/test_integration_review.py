"""Independent lifecycle races: an old grant must not replace a new connection."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event
from urllib.parse import parse_qs, urlencode, urlsplit

import pytest
from cryptography.fernet import Fernet

from app.config import Settings
from app.errors import AppError
from app.integrations import GoogleIntegration
from app.providers import ProviderError
from app.store import Store


def grant(label, *, expired=False, refresh=True):
    return {
        "access_token": "access-" + label,
        "refresh_token": "refresh-" + label if refresh else None,
        "expires_at": (datetime.now(UTC) + timedelta(hours=-1 if expired else 1)).isoformat(),
        "scope": "https://www.googleapis.com/auth/calendar.events.readonly",
        "token_type": "Bearer",
        "source": "mock",
    }


class ControlledOAuth:
    configured = True

    def __init__(self):
        self.exchange_result = grant("initial", expired=True)
        self.refresh_entered = Event()
        self.refresh_release = Event()
        self.refresh_error = None
        self.revoked = []

    def authorization_url(self, state, challenge):
        return "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode({"state": state})

    def exchange(self, code, verifier):
        return dict(self.exchange_result)

    def refresh(self, refresh_token):
        self.refresh_entered.set()
        assert self.refresh_release.wait(timeout=5), "Review test did not release refresh"
        if self.refresh_error is not None:
            raise self.refresh_error
        return grant("stale-refreshed")

    def revoke(self, token):
        self.revoked.append(token)


@pytest.fixture
def connected(tmp_path):
    settings = Settings(
        database_path=tmp_path / "integration-review.sqlite3",
        provider_mode="live",
        google_client_id="synthetic-client",
        google_client_secret="synthetic-secret",
        google_redirect_uri="http://127.0.0.1:18085/callback",
        token_encryption_key=Fernet.generate_key().decode(),
    )
    store = Store(settings.database_path)
    store.initialize()
    uid = store.register("review@example.test", "synthetic-password")["user"]["id"]
    oauth = ControlledOAuth()
    integration = GoogleIntegration(
        store, settings, oauth=oauth, calendar_factory=lambda token: token
    )
    connect(integration, uid)
    return integration, store, uid, oauth


def connect(integration, uid):
    link = integration.authorize(uid)["authorization_url"]
    state = parse_qs(urlsplit(link).query)["state"][0]
    integration.callback(state, "synthetic-authorization-code", None)


def saved_tokens(integration, store, uid):
    with store.connection() as connection:
        row = connection.execute(
            "SELECT * FROM provider_tokens WHERE user_id = ?", (uid,)
        ).fetchone()
    return integration.decode(row["encrypted"]) if row is not None else None


@pytest.mark.parametrize("reauthorization_error", [False, True])
def test_refresh_from_old_connection_cannot_overwrite_or_delete_reconnected_grant(
    connected, reauthorization_error
):
    integration, store, uid, oauth = connected
    if reauthorization_error:
        oauth.refresh_error = ProviderError(
            "oauth_reauthorization_required", "Synthetic revoked grant", http_status=401
        )
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(integration.provider, uid)
        try:
            assert oauth.refresh_entered.wait(timeout=5)
            assert integration.disconnect(uid)["connected"] is False
            oauth.exchange_result = grant("new-google-account")
            connect(integration, uid)
        finally:
            oauth.refresh_release.set()
        with pytest.raises((AppError, ProviderError)):
            pending.result(timeout=5)
    assert saved_tokens(integration, store, uid)["access_token"] == "access-new-google-account"
    assert integration.provider(uid) == "access-new-google-account"


def test_new_consent_without_refresh_does_not_inherit_another_google_account_grant(connected):
    integration, store, uid, oauth = connected
    oauth.exchange_result = grant("different-google-account", refresh=False)
    with pytest.raises(AppError) as rejected:
        connect(integration, uid)
    assert rejected.value.code == "oauth_refresh_missing"
    tokens = saved_tokens(integration, store, uid)
    assert tokens["access_token"] == "access-initial"
    assert tokens["refresh_token"] == "refresh-initial"


def test_disconnect_during_refresh_does_not_recreate_removed_connection(connected):
    integration, store, uid, oauth = connected
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(integration.provider, uid)
        try:
            assert oauth.refresh_entered.wait(timeout=5)
            integration.disconnect(uid)
        finally:
            oauth.refresh_release.set()
        with pytest.raises(AppError) as rejected:
            pending.result(timeout=5)
        assert rejected.value.code == "google_connection_changed"
    assert saved_tokens(integration, store, uid) is None


def test_account_removal_during_refresh_cannot_leave_provider_tokens(connected):
    integration, store, uid, oauth = connected
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(integration.provider, uid)
        try:
            assert oauth.refresh_entered.wait(timeout=5)
            store.delete_account(uid)
        finally:
            oauth.refresh_release.set()
        with pytest.raises(AppError):
            pending.result(timeout=5)
    assert saved_tokens(integration, store, uid) is None


@pytest.mark.parametrize("cancel", [None, "disconnect", "account"])
def test_overlapping_refreshes_share_one_exchange_and_recheck_after_wait(connected, cancel):
    integration, store, uid, oauth = connected
    calls = []

    def refresh(token):
        calls.append(token)
        if len(calls) > 1:
            raise ProviderError(
                "oauth_reauthorization_required", "Synthetic reused refresh token", http_status=401
            )
        oauth.refresh_entered.set()
        assert oauth.refresh_release.wait(5)
        return grant("winner")

    oauth.refresh = refresh
    second = GoogleIntegration(
        store, integration.settings, oauth=oauth, calendar_factory=lambda token: token
    )
    second_read = Event()
    original_decode = second.decode

    def observe_decode(value):
        decoded = original_decode(value)
        second_read.set()
        return decoded

    second.decode = observe_decode
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(integration.provider, uid)
        assert oauth.refresh_entered.wait(5)
        waiting = pool.submit(second.provider, uid)
        try:
            assert second_read.wait(5), "Second request must observe the expired grant"
            if cancel == "disconnect":
                integration.disconnect(uid)
            elif cancel == "account":
                store.delete_account(uid)
        finally:
            oauth.refresh_release.set()
        if cancel is None:
            assert first.result(5) == waiting.result(5) == "access-winner"
        else:
            with pytest.raises(AppError):
                first.result(5)
            with pytest.raises(AppError) as error:
                waiting.result(5)
            assert error.value.code == "google_not_connected"
    assert len(calls) == 1
    assert integration.status(uid)["connected"] is (cancel is None)


def test_expired_refresh_token_disconnects_without_provider_call(connected):
    integration, store, uid, oauth = connected
    with store.connection() as connection:
        row = connection.execute(
            "SELECT encrypted FROM provider_tokens WHERE user_id = ?", (uid,)
        ).fetchone()
        tokens = integration.decode(row["encrypted"])
        tokens["refresh_token_expires_at"] = (datetime.now(UTC) - timedelta(days=1)).isoformat()
        connection.execute(
            "UPDATE provider_tokens SET encrypted = ? WHERE user_id = ?",
            (integration.encode(tokens), uid),
        )
    with pytest.raises(AppError) as error:
        integration.provider(uid)
    assert error.value.code == "oauth_reauthorization_required"
    assert integration.status(uid)["connected"] is False
    assert not oauth.refresh_entered.is_set()
