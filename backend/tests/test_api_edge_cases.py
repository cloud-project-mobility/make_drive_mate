"""Independent regressions for HTTP boundary and date-range failures."""

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import BodyLimit, create_app


@pytest.fixture
def edge_client(tmp_path):
    with TestClient(create_app(Settings(database_path=tmp_path / "edge.sqlite3"))) as client:
        result = client.post(
            "/api/v1/auth/register",
            json={"email": "edge@example.test", "password": "offline-fixture-password"},
        )
        assert result.status_code == 201
        client.headers["Authorization"] = "Bearer " + result.json()["access_token"]
        yield client


@pytest.mark.parametrize(
    "params",
    [
        {"time_min": "9999-12-31T00:00:00Z"},
        {
            "time_min": "0001-01-01T00:00:00+14:00",
            "time_max": "0001-01-02T00:00:00+14:00",
        },
        {
            "time_min": "9999-12-31T00:00:00Z",
            "time_max": "9999-12-31T23:00:00Z",
        },
        {
            "time_min": "2026-10-28T00:00:00",
            "time_max": "2026-10-29T00:00:00Z",
        },
    ],
)
def test_calendar_extreme_or_naive_windows_return_validation_error(edge_client, params):
    response = edge_client.get("/api/v1/calendar/events", params=params)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_window"
    assert edge_client.get("/api/v1/health").status_code == 200


@pytest.mark.parametrize("content", [b"null", b"", b"[]"])
def test_invalid_body_does_not_replace_snapshot(edge_client, content):
    response = edge_client.put(
        "/api/v1/state", content=content, headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422
    assert edge_client.get("/api/v1/state").json()["revision"] == 0


def test_body_limit_does_not_dispatch_a_disconnected_request():
    dispatched, sent = [], []

    async def application(scope, receive, send):
        dispatched.append(True)

    messages = iter(
        [
            {"type": "http.request", "body": b"partial", "more_body": True},
            {"type": "http.disconnect"},
        ]
    )

    async def receive():
        return next(messages)

    async def send(message):
        sent.append(message)

    asyncio.run(BodyLimit(application, limit=100)({"type": "http"}, receive, send))
    assert dispatched == []
    assert sent == []


def test_body_limit_counts_chunked_bytes_without_content_length():
    dispatched, sent = [], []

    async def application(scope, receive, send):
        dispatched.append(True)

    messages = iter(
        [
            {"type": "http.request", "body": b"123", "more_body": True},
            {"type": "http.request", "body": b"456", "more_body": False},
        ]
    )

    async def receive():
        return next(messages)

    async def send(message):
        sent.append(message)

    asyncio.run(BodyLimit(application, limit=5)({"type": "http"}, receive, send))
    assert dispatched == []
    assert sent[0]["status"] == 413
