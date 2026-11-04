from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(Settings(database_path=tmp_path / "app.sqlite3"))) as client:
        yield client


def register(client, email="student@example.test"):
    response = client.post(
        "/api/v1/auth/register", json={"email": email, "password": "demo-password-123"}
    )
    assert response.status_code == 201, response.text
    return {"Authorization": "Bearer " + response.json()["access_token"]}


def state():
    return {
        "version": 1,
        "vehicles": [
            {
                "id": "vehicle-1",
                "name": "테스트 차량",
                "model": "아이오닉 5",
                "powertrain": "EV",
                "odometerKm": 1000,
                "createdAt": "2026-10-28T10:00:00+09:00",
            }
        ],
        "selectedVehicleId": "vehicle-1",
        "trips": [],
        "plans": [],
        "maintenance": [],
        "activeTrip": None,
        "settings": {"walkMinutes": 10, "bufferMinutes": 10},
        "onboarded": True,
        "demoMode": False,
    }


def upload(client, auth, data, revision=0):
    return client.put(
        "/api/v1/state", headers=auth, json={"expected_revision": revision, "state": data}
    )


def test_health_and_authentication(client):
    assert client.get("/api/v1/health").json()["provider_mode"] == "mock"
    assert client.get("/api/v1/state").status_code == 401
    auth = register(client)
    assert client.get("/api/v1/auth/me", headers=auth).json()["email"] == "student@example.test"
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"email": "STUDENT@example.test", "password": "demo-password-123"},
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"email": "student@example.test", "password": "incorrect-password"},
        ).status_code
        == 401
    )
    client.post("/api/v1/auth/logout", headers=auth)
    assert client.get("/api/v1/state", headers=auth).status_code == 401


def test_persistence_and_account_isolation(client):
    first, second = register(client), register(client, "other@example.test")
    saved = upload(client, first, state()).json()
    assert saved["revision"] == 1
    assert saved["state"] == state()
    assert client.get("/api/v1/state", headers=first).json() == saved
    assert client.get("/api/v1/state", headers=second).json()["state"] is None
    # A new app instance reads the same on-disk state and session.
    with TestClient(create_app(client.app.state.settings)) as restarted:
        assert restarted.get("/api/v1/state", headers=first).json() == saved


def test_idempotency_and_conflicts(client):
    auth, data = register(client), state()
    first = upload(client, auth, data).json()
    assert upload(client, auth, data).json() == first
    changed = deepcopy(data)
    changed["vehicles"][0]["odometerKm"] += 10
    assert upload(client, auth, changed).status_code == 409
    assert upload(client, auth, changed, 1).json()["revision"] == 2
    assert upload(client, auth, data, 1).status_code == 409
    assert client.get("/api/v1/state", headers=auth).json()["state"] == changed


def test_simultaneous_writes_one_winner(client):
    auth = register(client)
    upload(client, auth, state())
    copies = [state(), state()]
    copies[0]["vehicles"][0]["name"] = "기기 A"
    copies[1]["vehicles"][0]["name"] = "기기 B"
    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(lambda data: upload(client, auth, data, 1).status_code, copies))
    assert sorted(statuses) == [200, 409]
    assert client.get("/api/v1/state", headers=auth).json()["revision"] == 2


def test_account_delete_cascades_and_invalidates_all_sessions(client):
    auth = register(client)
    upload(client, auth, state())
    another = client.post(
        "/api/v1/auth/login",
        json={"email": "student@example.test", "password": "demo-password-123"},
    ).json()["access_token"]
    assert client.delete("/api/v1/account", headers=auth).status_code == 200
    assert (
        client.get("/api/v1/state", headers={"Authorization": "Bearer " + another}).status_code
        == 401
    )
    with client.app.state.store.connection() as con:
        assert con.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0] == 0
        assert con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0


@pytest.mark.parametrize(
    "mutate",
    [
        lambda s: s.update(version=True),
        lambda s: s.update(onboarded=False),
        lambda s: s.update(selectedVehicleId="missing"),
        lambda s: s["vehicles"].append(deepcopy(s["vehicles"][0])),
        lambda s: s["vehicles"][0].update(odometerKm=True),
        lambda s: s["vehicles"][0].update(odometerKm=-1),
        lambda s: s["vehicles"][0].update(odometerKm="1000"),
        lambda s: s["vehicles"][0].update(name="   "),
        lambda s: s["vehicles"][0].update(createdAt="2026-02-30T12:00:00Z"),
        lambda s: s["vehicles"][0].update(createdAt="2026-10-28T12:00:00"),
        lambda s: s.update(
            maintenance=[
                {
                    "id": "m1",
                    "vehicleId": "vehicle-1",
                    "itemId": "engine-oil",
                    "odometerKm": 900,
                    "performedAt": "2026-10-27T10:00:00Z",
                }
            ]
        ),
        lambda s: s.update(
            maintenance=[
                {
                    "id": "m1",
                    "vehicleId": "vehicle-1",
                    "itemId": "tires",
                    "odometerKm": 1001,
                    "performedAt": "2026-10-27T10:00:00Z",
                }
            ]
        ),
        lambda s: s.update(
            activeTrip={
                "id": "active",
                "vehicleId": "vehicle-1",
                "startedAt": "2026-10-28T10:00:00Z",
                "distanceKm": 0,
                "durationSeconds": 0,
            }
        ),
    ],
)
def test_reject_invalid_snapshot_without_replacing_valid(client, mutate):
    auth = register(client)
    upload(client, auth, state())
    invalid = state()
    mutate(invalid)
    assert upload(client, auth, invalid, 1).status_code == 422
    assert client.get("/api/v1/state", headers=auth).json()["state"] == state()


def test_trip_distance_roundtrip_never_added_again(client):
    auth, data = register(client), state()
    data["trips"] = [
        {
            "id": "t1",
            "vehicleId": "vehicle-1",
            "startedAt": "2026-10-28T01:00:00Z",
            "endedAt": "2026-10-28T02:00:00Z",
            "durationSeconds": 3600,
            "distanceKm": 50,
            "source": "gps",
        }
    ]
    data["vehicles"][0]["odometerKm"] = 1050
    for _ in range(3):
        assert upload(client, auth, data).json()["state"]["vehicles"][0]["odometerKm"] == 1050


def test_route_departure_crosses_midnight_and_is_labelled(client):
    auth = register(client)
    origin = client.get("/api/v1/places", params={"q": "서울역"}, headers=auth).json()["places"][0]
    destination = client.get("/api/v1/places", params={"q": "서울시청"}, headers=auth).json()[
        "places"
    ][0]

    def point(p):
        return {k: p[k] for k in ("longitude", "latitude")}

    response = client.post(
        "/api/v1/routes",
        headers=auth,
        json={
            "origin": point(origin),
            "destination": point(destination),
            "arrival_at": "2026-10-29T00:10:00+09:00",
            "walk_minutes": 10,
            "buffer_minutes": 10,
        },
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["source"] == "mock"
    assert result["departure_at"].startswith("2026-10-28T23:")
    assert (
        datetime.fromisoformat(result["expires_at"]) - datetime.fromisoformat(result["computed_at"])
    ).total_seconds() == 300


def test_unknown_route_does_not_invent_eta(client):
    auth = register(client)
    response = client.post(
        "/api/v1/routes",
        headers=auth,
        json={
            "origin": {"longitude": 1, "latitude": 2},
            "destination": {"longitude": 3, "latitude": 4},
            "arrival_at": "2026-10-29T10:00:00Z",
        },
    )
    assert response.status_code == 422
    assert "duration_s" not in response.json()


def test_calendar_and_vehicle_fixtures(client):
    auth = register(client)
    response = client.get("/api/v1/calendar/events", headers=auth)
    assert response.status_code == 200, response.text
    events = response.json()
    assert events["source"] == "mock"
    assert any(e["all_day"] and e["start_at"] is None for e in events["events"])
    assert (
        client.get("/api/v1/calendar/events?time_min=2026-10-28T10:00:00", headers=auth).status_code
        == 422
    )
    vehicle = client.get("/api/v1/vehicles/status", headers=auth)
    assert vehicle.status_code == 200, vehicle.text
    assert vehicle.json()["source"] == "mock"
    assert client.get("/api/v1/state", headers=auth).json()["state"] is None


def test_expired_session_and_no_raw_secret_response(client):
    auth = register(client)
    with client.app.state.store.connection() as con:
        con.execute("UPDATE sessions SET expires_at = 0")
    assert client.get("/api/v1/state", headers=auth).status_code == 401
    response = client.post("/api/v1/auth/login", json={"email": "broken", "password": "secret1234"})
    assert response.status_code == 422
    assert "secret1234" not in response.text


def test_rate_limit_and_no_plaintext_secrets_in_database(client):
    auth = register(client)
    for _ in range(9):
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"email": "student@example.test", "password": "incorrect-password"},
            ).status_code
            == 401
        )
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"email": "student@example.test", "password": "incorrect-password"},
        ).status_code
        == 429
    )
    with client.app.state.store.connection() as con:
        rows = str(con.execute("SELECT * FROM accounts").fetchall())
        rows += str([tuple(r) for r in con.execute("SELECT * FROM sessions")])
    assert "demo-password-123" not in rows
    assert auth["Authorization"][7:] not in rows


def test_disconnected_provider_and_cors(tmp_path):
    settings = Settings(
        database_path=tmp_path / "db", provider_mode="disconnected", max_body_bytes=2048
    )
    with TestClient(create_app(settings)) as client:
        auth = register(client)
        assert client.get("/api/v1/places?q=서울역", headers=auth).status_code == 503
        assert client.post("/api/v1/auth/login", content=b"x" * 2049).status_code == 413
        response = client.options(
            "/api/v1/state",
            headers={"Origin": "https://untrusted.example", "Access-Control-Request-Method": "GET"},
        )
        assert "access-control-allow-origin" not in response.headers
        response = client.options(
            "/api/v1/state",
            headers={"Origin": "http://localhost:8081", "Access-Control-Request-Method": "GET"},
        )
        assert response.headers["access-control-allow-origin"] == "http://localhost:8081"
