import importlib.util
import json
from datetime import UTC, datetime

import pytest

from hyundai_experiments.client import ExperimentResult
from hyundai_experiments.config import PROJECT_ROOT
from hyundai_experiments.errors import Status


@pytest.fixture
def suite(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("suite", PROJECT_ROOT / "scripts/verify_suite.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "PROJECT_ROOT", tmp_path)
    return module


def test_initial_odometer_failure_stops_suite(suite, monkeypatch):
    calls = []

    def failed(settings, api):
        calls.append(api)
        return ExperimentResult("SAMPLE", Status.AUTH_FAILED, datetime.now(UTC), api=api)

    monkeypatch.setattr("sys.argv", ["verify_suite.py"])
    monkeypatch.setattr(suite, "run_sample", failed)
    assert suite.main() == 1
    assert calls == ["odometer"]


def test_resume_avoids_duplicate_odometer_and_stops_on_rate_limit(suite, monkeypatch, tmp_path):
    evidence = tmp_path / "prior.json"
    evidence.write_text(
        json.dumps(
            {
                "api": "odometer",
                "source": "SAMPLE",
                "status": "sample_validated",
                "network_attempted": True,
                "structure_valid": True,
            }
        )
    )
    calls = []

    def limited(settings, api):
        calls.append(api)
        return ExperimentResult("SAMPLE", Status.RATE_LIMITED, datetime.now(UTC), api=api)

    monkeypatch.setattr("sys.argv", ["verify_suite.py", "--resume-from", str(evidence)])
    monkeypatch.setattr(suite, "run_sample", limited)
    assert suite.main() == 1
    assert calls == ["dte"]


def test_mock_evidence_cannot_unlock_remaining_live_calls(suite, monkeypatch, tmp_path):
    evidence = tmp_path / "prior.json"
    evidence.write_text(
        json.dumps(
            {
                "api": "odometer",
                "source": "MOCK",
                "status": "mock_only_validated",
                "network_attempted": False,
                "structure_valid": True,
            }
        )
    )

    def forbidden(*args, **kwargs):
        raise AssertionError("Mock evidence allowed live request")

    monkeypatch.setattr("sys.argv", ["verify_suite.py", "--resume-from", str(evidence)])
    monkeypatch.setattr(suite, "run_sample", forbidden)
    assert suite.main() == 2
