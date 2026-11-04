"""Exercise real loopback HTTP, forced process termination, and durable SQLite state.

Uses disposable accounts/database and mock providers. Never loads credentials.
Run: uv run python scripts/verify_restart.py
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

PORT = 18087
BASE = f"http://127.0.0.1:{PORT}/api/v1"
OPENER = build_opener(ProxyHandler({}))


def request(method, endpoint, body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = Request(
        BASE + endpoint,
        data=json.dumps(body).encode() if body else None,
        headers=headers,
        method=method,
    )
    try:
        with OPENER.open(req, timeout=3) as response:
            return response.status, json.load(response)
    except HTTPError as exc:
        return exc.code, json.load(exc)


def start(env, logs):
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(PORT),
            "--no-access-log",
        ],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        stdout=logs,
        stderr=logs,
    )
    try:
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError("Test backend exited before readiness")
            try:
                status, body = request("GET", "/health")
                if status == 200 and body["provider_mode"] == "mock":
                    return process
            except (URLError, TimeoutError, OSError):
                pass
            time.sleep(0.1)
        raise RuntimeError("Test backend readiness timed out")
    except BaseException:
        process.kill()
        process.wait(timeout=5)
        raise


def main():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", PORT))
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(("DRIVEMATE_", "GOOGLE_", "KAKAO_", "HYUNDAI_"))
    }
    with (
        tempfile.TemporaryDirectory(prefix="drivemate-restart-") as directory,
        tempfile.TemporaryFile() as logs,
    ):
        env.update(
            DRIVEMATE_PROVIDER_MODE="mock", DRIVEMATE_DATABASE=str(Path(directory) / "db.sqlite3")
        )
        process = start(env, logs)
        try:
            code, account = request(
                "POST",
                "/auth/register",
                {"email": "restart@example.test", "password": "synthetic-test-password"},
            )
            assert code == 201
            token = account["access_token"]
            state = {
                "version": 1,
                "vehicles": [
                    {
                        "id": "v1",
                        "name": "재시작 검증 차량",
                        "model": "EV 예시",
                        "powertrain": "EV",
                        "odometerKm": 1050,
                        "createdAt": "2026-10-28T00:00:00Z",
                    }
                ],
                "selectedVehicleId": "v1",
                "trips": [
                    {
                        "id": "t1",
                        "vehicleId": "v1",
                        "distanceKm": 50,
                        "durationSeconds": 3600,
                        "startedAt": "2026-10-28T00:00:00Z",
                        "endedAt": "2026-10-28T01:00:00Z",
                        "source": "gps",
                    }
                ],
                "plans": [],
                "maintenance": [],
                "activeTrip": None,
                "settings": {"walkMinutes": 10, "bufferMinutes": 10},
                "onboarded": True,
                "demoMode": False,
            }
            payload = {"expected_revision": 0, "state": state}
            code, saved = request("PUT", "/state", payload, token)
            assert code == 200 and saved["revision"] == 1
            print("PASS: real HTTP account and snapshot commit", flush=True)
            process.kill()
            process.wait(timeout=5)
            process = start(env, logs)
            code, restored = request("GET", "/state", token=token)
            assert code == 200 and restored == saved
            print(
                "PASS: forced process termination preserves committed database and session",
                flush=True,
            )
            code, retried = request("PUT", "/state", payload, token)
            assert code == 200 and retried == saved
            assert retried["state"]["vehicles"][0]["odometerKm"] == 1050
            print(
                "PASS: retry after restart does not duplicate trip distance or revision", flush=True
            )
            payload["state"]["vehicles"][0]["name"] = "stale writer"
            assert request("PUT", "/state", payload, token)[0] == 409
            assert request("GET", "/state", token=token)[1] == saved
            print("PASS: stale divergent write rejected after restart", flush=True)
            assert request("DELETE", "/account", token=token)[0] == 200
            assert request("GET", "/state", token=token)[0] == 401
            print("PASS: account deletion invalidates durable session", flush=True)
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)


if __name__ == "__main__":
    main()
