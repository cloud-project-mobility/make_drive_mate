"""All tests run without credentials and cannot connect to external sockets."""

import os
import socket

import pytest

# Apply before test-module imports can construct the default app. Tests needing
# configured providers inject synthetic values directly, never ambient secrets.
for _key in list(os.environ):
    if _key.startswith(("DRIVEMATE_", "KAKAO_", "GOOGLE_", "HYUNDAI_")):
        del os.environ[_key]
os.environ["DRIVEMATE_PROVIDER_MODE"] = "mock"


@pytest.fixture(autouse=True)
def block_network(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Network access is forbidden in offline tests")

    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
