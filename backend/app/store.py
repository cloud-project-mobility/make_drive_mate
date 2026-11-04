"""Transactional SQLite persistence, scoped by authenticated account."""

import hashlib
import hmac
import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from .errors import AppError


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def password_hash(password: str, salt: str) -> str:
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()


class Store:
    def __init__(self, path: Path, session_hours: int = 12):
        self.path = path
        self.session_hours = session_hours

    @contextmanager
    def connection(self):
        con = sqlite3.connect(self.path, timeout=10)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        try:
            with con:
                yield con
        finally:
            con.close()

    def initialize(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as con:
            con.execute("PRAGMA journal_mode = WAL")
            version = con.execute("PRAGMA user_version").fetchone()[0]
            if version not in {0, 1, 2}:
                raise RuntimeError("Unsupported database schema; database left unchanged")
            con.executescript("""
                CREATE TABLE IF NOT EXISTS accounts (
                    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
                    salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                    expires_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS snapshots (
                    user_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
                    revision INTEGER NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS rate_limits (
                    bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS oauth_states (
                    state_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                    verifier BLOB NOT NULL, expires_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS provider_tokens (
                    user_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
                    encrypted BLOB NOT NULL, revision INTEGER NOT NULL
                );
                PRAGMA user_version = 2;
            """)
        self.path.chmod(0o600)

    def rate_limit(self, bucket: str, limit: int, window: int):
        current = time.time()
        with self.connection() as con:
            con.execute("BEGIN IMMEDIATE")
            con.execute("DELETE FROM rate_limits WHERE reset_at <= ?", (current,))
            row = con.execute(
                "SELECT attempts FROM rate_limits WHERE bucket = ?", (bucket,)
            ).fetchone()
            if row and row["attempts"] >= limit:
                raise AppError("rate_limited", "요청이 많아요. 잠시 후 다시 시도해 주세요.", 429)
            con.execute(
                "INSERT INTO rate_limits VALUES (?, 1, ?) "
                "ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1",
                (bucket, current + window),
            )

    def register(self, email: str, password: str) -> dict:
        uid, salt = str(uuid4()), secrets.token_hex(16)
        hashed = password_hash(password, salt)
        with self.connection() as con:
            try:
                con.execute(
                    "INSERT INTO accounts VALUES (?, ?, ?, ?, ?)",
                    (uid, email, salt, hashed, now_iso()),
                )
            except sqlite3.IntegrityError as exc:
                raise AppError("email_exists", "이미 등록된 이메일이에요.", 409) from exc
            return self._session(con, {"id": uid, "email": email})

    def login(self, email: str, password: str) -> dict:
        with self.connection() as con:
            row = con.execute("SELECT * FROM accounts WHERE email = ?", (email,)).fetchone()
            # Perform the same expensive operation even for an unknown email.
            salt = row["salt"] if row else "00" * 16
            actual = password_hash(password, salt)
            expected = row["password_hash"] if row else "00" * 64
            if not hmac.compare_digest(actual, expected) or row is None:
                raise AppError("invalid_credentials", "이메일 또는 비밀번호를 확인해 주세요.", 401)
            return self._session(con, {"id": row["id"], "email": row["email"]})

    def _session(self, con, user: dict) -> dict:
        token = secrets.token_urlsafe(32)
        expires = datetime.now(UTC) + timedelta(hours=self.session_hours)
        con.execute("DELETE FROM sessions WHERE expires_at <= ?", (time.time(),))
        con.execute(
            "INSERT INTO sessions VALUES (?, ?, ?)",
            (digest(token), user["id"], expires.timestamp()),
        )
        return {
            "access_token": token,
            "token_type": "bearer",
            "user": user,
            "expires_at": expires.isoformat(),
        }

    def authenticate(self, token: str) -> dict:
        with self.connection() as con:
            row = con.execute(
                "SELECT accounts.id, accounts.email FROM sessions JOIN accounts "
                "ON accounts.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?",
                (digest(token), time.time()),
            ).fetchone()
        if row is None:
            raise AppError("unauthorized", "로그인이 필요하거나 세션이 만료됐어요.", 401)
        return dict(row)

    def logout(self, token: str):
        with self.connection() as con:
            con.execute("DELETE FROM sessions WHERE token_hash = ?", (digest(token),))

    def delete_account(self, uid: str):
        with self.connection() as con:
            con.execute("DELETE FROM accounts WHERE id = ?", (uid,))

    def state(self, uid: str) -> dict:
        with self.connection() as con:
            row = con.execute("SELECT * FROM snapshots WHERE user_id = ?", (uid,)).fetchone()
        return self._snapshot(row)

    @staticmethod
    def _snapshot(row) -> dict:
        if row is None:
            return {"revision": 0, "state": None, "updated_at": None}
        return {
            "revision": row["revision"],
            "state": json.loads(row["body"]),
            "updated_at": row["updated_at"],
        }

    def save_state(self, uid: str, expected: int, state: dict) -> dict:
        body = json.dumps(
            state, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
        )
        if len(body.encode()) > 5 * 1024 * 1024:
            raise AppError("snapshot_too_large", "백업은 5 MB 이하여야 해요.", 413)
        with self.connection() as con:
            con.execute("BEGIN IMMEDIATE")
            row = con.execute("SELECT * FROM snapshots WHERE user_id = ?", (uid,)).fetchone()
            # An identical retry does not change revisions or re-apply trip distances.
            if row is not None and row["body"] == body:
                return self._snapshot(row)
            revision = row["revision"] if row else 0
            if revision != expected:
                raise AppError(
                    "revision_conflict", "서버에 더 새로운 백업이 있어요. 먼저 확인해 주세요.", 409
                )
            updated = now_iso()
            con.execute(
                "INSERT INTO snapshots VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET "
                "revision = excluded.revision, body = excluded.body, "
                "updated_at = excluded.updated_at",
                (uid, revision + 1, body, updated),
            )
            return {"revision": revision + 1, "state": state, "updated_at": updated}
