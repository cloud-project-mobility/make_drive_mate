"""Per-account Google consent state and encrypted provider tokens.

Only the backend receives OAuth access/refresh tokens. No token is shared between
accounts; callback states are one-use, expire after ten minutes, and bind PKCE.
"""

import base64
import hashlib
import json
import secrets
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from threading import Lock
from weakref import WeakValueDictionary

from cryptography.fernet import Fernet, InvalidToken

from .config import Settings
from .errors import AppError
from .providers import GoogleCalendarProvider, ProviderError
from .providers.google_oauth import GoogleOAuthClient
from .store import Store, digest


@dataclass(frozen=True)
class Grant:
    revision: int
    encrypted: bytes = field(repr=False)
    tokens: dict = field(repr=False)


# Serialize refreshes for an account across app instances in this process.
# Weak references release idle account locks; callers retain the lock while
# waiting or refreshing. Cross-process coordination still relies on SQLite CAS,
# so run one application worker until a durable refresh lease is implemented.
_REFRESH_LOCKS = WeakValueDictionary()
_REFRESH_LOCKS_GUARD = Lock()


class GoogleIntegration:
    def __init__(self, store: Store, settings: Settings, oauth=None, calendar_factory=None):
        self.store = store
        self.settings = settings
        self.oauth = oauth or GoogleOAuthClient(
            client_id=settings.google_client_id,
            client_secret=settings.google_client_secret,
            redirect_uri=settings.google_redirect_uri,
        )
        self.calendar_factory = calendar_factory or (
            lambda token: GoogleCalendarProvider(mode="live", access_token=token)
        )
        self.vault = None
        if settings.token_encryption_key:
            try:
                self.vault = Fernet(settings.token_encryption_key.encode())
            except (ValueError, TypeError) as exc:
                raise ValueError("DRIVEMATE_TOKEN_ENCRYPTION_KEY must be a Fernet key") from exc

    @property
    def configured(self) -> bool:
        return bool(
            self.settings.provider_mode == "live"
            and self.settings.google_client_id
            and self.settings.google_client_secret
            and self.settings.google_redirect_uri
            and self.vault
            and self.oauth.configured
        )

    def require_configured(self):
        if not self.configured:
            raise AppError(
                "oauth_not_configured", "Google 연결은 서버의 OAuth 설정 후 사용할 수 있어요.", 503
            )

    def encode(self, value: dict) -> bytes:
        self.require_configured()
        return self.vault.encrypt(json.dumps(value).encode())

    def decode(self, value: bytes) -> dict:
        self.require_configured()
        try:
            return json.loads(self.vault.decrypt(value))
        except (InvalidToken, ValueError, TypeError) as exc:
            raise AppError(
                "provider_reconnect_required",
                "Google 연결 정보를 읽을 수 없어 다시 연결해야 해요.",
                503,
            ) from exc

    def status(self, uid: str) -> dict:
        with self.store.connection() as con:
            row = con.execute("SELECT 1 FROM provider_tokens WHERE user_id = ?", (uid,)).fetchone()
        return {"configured": self.configured, "connected": bool(row), "live_verified": False}

    def authorize(self, uid: str) -> dict:
        self.require_configured()
        state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(64)
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .rstrip(b"=")
            .decode()
        )
        url = self.oauth.authorization_url(state, challenge)
        with self.store.connection() as con:
            con.execute(
                "DELETE FROM oauth_states WHERE user_id = ? OR expires_at <= ?", (uid, time.time())
            )
            con.execute(
                "INSERT INTO oauth_states VALUES (?, ?, ?, ?)",
                (digest(state), uid, self.encode({"verifier": verifier}), time.time() + 600),
            )
        return {"authorization_url": url, "expires_in": 600}

    def callback(self, state: str, code: str | None, error: str | None) -> None:
        self.require_configured()
        # Clear the encrypted verifier to claim state once, but retain the row while
        # exchanging. Disconnect/new consent deletes it, preventing stale reconnection.
        with self.store.connection() as con:
            con.execute("BEGIN IMMEDIATE")
            row = con.execute(
                "SELECT * FROM oauth_states WHERE state_hash = ?", (digest(state),)
            ).fetchone()
            if row is not None:
                con.execute(
                    "UPDATE oauth_states SET verifier = ? WHERE state_hash = ?",
                    (b"", digest(state)),
                )
        if row is None or not row["verifier"] or row["expires_at"] <= time.time():
            raise AppError(
                "invalid_oauth_state",
                "연결 요청이 만료되었거나 이미 사용됐어요. 앱에서 다시 연결해 주세요.",
                400,
            )
        if error or not code:
            raise AppError(
                "oauth_denied",
                "Google 연결이 승인되지 않았어요. 앱에서 다시 시도할 수 있어요.",
                400,
            )
        verifier = self.decode(row["verifier"])["verifier"]
        try:
            result = self.oauth.exchange(code, verifier)
        except ValueError as exc:
            raise AppError(
                "invalid_oauth_callback", "Google 인증 응답을 확인할 수 없어요.", 422
            ) from exc
        with self.store.connection() as con:
            con.execute("BEGIN IMMEDIATE")
            pending = con.execute(
                "SELECT 1 FROM oauth_states WHERE state_hash = ?", (digest(state),)
            ).fetchone()
            if not pending:
                raise AppError(
                    "google_connection_changed", "Google 연결 요청이 취소되거나 변경됐어요.", 409
                )
            if not con.execute("SELECT 1 FROM accounts WHERE id = ?", (row["user_id"],)).fetchone():
                raise AppError("account_removed", "삭제된 계정에는 연결할 수 없어요.", 409)
            if not result.get("refresh_token"):
                raise AppError(
                    "oauth_refresh_missing",
                    "지속적인 일정 조회를 위해 Google 연결 동의를 다시 진행해 주세요.",
                    409,
                )
            con.execute(
                "INSERT INTO provider_tokens VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET "
                "encrypted = excluded.encrypted, revision = provider_tokens.revision + 1",
                (row["user_id"], self.encode(result)),
            )
            con.execute("DELETE FROM oauth_states WHERE state_hash = ?", (digest(state),))

    def _load_grant(self, uid: str) -> Grant:
        with self.store.connection() as con:
            row = con.execute("SELECT * FROM provider_tokens WHERE user_id = ?", (uid,)).fetchone()
        if row is None:
            raise AppError(
                "google_not_connected", "먼저 Google Calendar 연결에 동의해 주세요.", 409
            )
        return Grant(row["revision"], row["encrypted"], self.decode(row["encrypted"]))

    def _discard_grant(self, uid: str, grant: Grant) -> None:
        with self.store.connection() as con:
            con.execute(
                "DELETE FROM provider_tokens WHERE user_id = ? AND revision = ? AND encrypted = ?",
                (uid, grant.revision, grant.encrypted),
            )

    def _current_grant(self, uid: str, grant: Grant) -> bool:
        with self.store.connection() as con:
            return (
                con.execute(
                    "SELECT 1 FROM provider_tokens WHERE user_id = ? "
                    "AND revision = ? AND encrypted = ?",
                    (uid, grant.revision, grant.encrypted),
                ).fetchone()
                is not None
            )

    def _refresh_lock(self, uid: str):
        key = (str(self.store.path.resolve()), uid)
        with _REFRESH_LOCKS_GUARD:
            lock = _REFRESH_LOCKS.get(key)
            if lock is None:
                lock = Lock()
                _REFRESH_LOCKS[key] = lock
            return lock

    @staticmethod
    def _needs_refresh(grant: Grant, rejected: Grant | None) -> bool:
        return (
            datetime.fromisoformat(grant.tokens["expires_at"])
            <= datetime.now(UTC) + timedelta(seconds=60)
            or rejected is not None
            and grant.revision == rejected.revision
            and grant.encrypted == rejected.encrypted
        )

    def _credentials(self, uid: str, *, rejected: Grant | None = None) -> Grant:
        self.require_configured()
        grant = self._load_grant(uid)
        if not self._needs_refresh(grant, rejected):
            return grant
        with self._refresh_lock(uid):
            # A waiting request must reuse the winner's grant, or observe that
            # disconnect/account removal deleted it, before calling Google.
            grant = self._load_grant(uid)
            if not self._needs_refresh(grant, rejected):
                return grant
            tokens = grant.tokens
            refresh_expiry = tokens.get("refresh_token_expires_at")
            if refresh_expiry and datetime.fromisoformat(refresh_expiry) <= datetime.now(UTC):
                self._discard_grant(uid, grant)
                raise AppError(
                    "oauth_reauthorization_required",
                    "Google 연결 동의가 만료됐어요. 다시 연결해 주세요.",
                    409,
                )
            try:
                fresh = self.oauth.refresh(tokens["refresh_token"])
            except ProviderError as exc:
                if exc.code == "oauth_reauthorization_required":
                    self._discard_grant(uid, grant)
                raise
            fresh["refresh_token"] = fresh.get("refresh_token") or tokens["refresh_token"]
            if fresh["refresh_token"] == tokens["refresh_token"] and not fresh.get(
                "refresh_token_expires_at"
            ):
                fresh["refresh_token_expires_at"] = tokens.get("refresh_token_expires_at")
            encrypted = self.encode(fresh)
            with self.store.connection() as con:
                cursor = con.execute(
                    "UPDATE provider_tokens SET encrypted = ?, revision = revision + 1 "
                    "WHERE user_id = ? AND revision = ? AND encrypted = ?",
                    (encrypted, uid, grant.revision, grant.encrypted),
                )
                if cursor.rowcount != 1:
                    raise AppError(
                        "google_connection_changed",
                        "Google 연결이 변경됐어요. 다시 조회해 주세요.",
                        409,
                    )
            return Grant(grant.revision + 1, encrypted, fresh)

    def provider(self, uid: str) -> GoogleCalendarProvider:
        return self.calendar_factory(self._credentials(uid).tokens["access_token"])

    def list_events(self, uid: str, *, time_min: datetime, time_max: datetime) -> dict:
        grant = self._credentials(uid)
        for attempt in range(2):
            try:
                result = self.calendar_factory(grant.tokens["access_token"]).list_events(
                    time_min=time_min, time_max=time_max
                )
            except ProviderError as exc:
                # A permission/quota 403 is not proof that a token expired.
                if exc.upstream_status != 401:
                    raise
                if attempt == 0:
                    grant = self._credentials(uid, rejected=grant)
                    continue
                self._discard_grant(uid, grant)
                raise ProviderError(
                    "oauth_reauthorization_required",
                    "Google 캘린더 연결 동의가 다시 필요합니다.",
                    http_status=401,
                    upstream_status=401,
                ) from None
            if not self._current_grant(uid, grant):
                raise AppError(
                    "google_connection_changed",
                    "Google 연결이 변경됐어요. 다시 조회해 주세요.",
                    409,
                )
            return result
        raise AssertionError("unreachable")  # pragma: no cover

    def disconnect(self, uid: str) -> dict:
        # Local deletion succeeds even if the provider cannot be reached for revocation.
        with self.store.connection() as con:
            con.execute("BEGIN IMMEDIATE")
            row = con.execute(
                "SELECT encrypted FROM provider_tokens WHERE user_id = ?", (uid,)
            ).fetchone()
            con.execute("DELETE FROM provider_tokens WHERE user_id = ?", (uid,))
            con.execute("DELETE FROM oauth_states WHERE user_id = ?", (uid,))
        revoked = None
        if row is not None and self.configured:
            try:
                tokens = self.decode(row["encrypted"])
                self.oauth.revoke(tokens.get("refresh_token") or tokens["access_token"])
                revoked = True
            except (ProviderError, AppError):
                revoked = False
        return {"connected": False, "provider_revoked": revoked}
