import copy
import json
import socket

import pytest

from hyundai_experiments.config import PROJECT_ROOT


@pytest.fixture(autouse=True)
def forbid_external_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError("Offline test attempted external network access")

    monkeypatch.setattr(socket, "getaddrinfo", blocked)
    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket.socket, "connect_ex", blocked)
    monkeypatch.setattr(socket, "create_connection", blocked)


@pytest.fixture
def payload():
    path = PROJECT_ROOT / "fixtures" / "mock_responses" / "odometer.json"
    return copy.deepcopy(json.loads(path.read_text(encoding="utf-8")))
