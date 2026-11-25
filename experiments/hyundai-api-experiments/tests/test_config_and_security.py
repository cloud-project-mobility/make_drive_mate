import importlib.util
import json
from pathlib import Path

import pytest

from hyundai_experiments.client import run_mock, run_sample
from hyundai_experiments.config import PROJECT_ROOT, Settings
from hyundai_experiments.errors import Status
from hyundai_experiments.redaction import redact


def test_file_beats_process_environment_and_does_not_expand(tmp_path, monkeypatch):
    monkeypatch.setenv("HYUNDAI_SAMPLE_TOKEN", "process-value")
    path = tmp_path / ".env"
    path.write_text(
        "HYUNDAI_SAMPLE_TOKEN=local-value\nHYUNDAI_SAMPLE_CAR_ID=mock-car\n", encoding="utf-8-sig"
    )
    settings = Settings.from_env_file(path)
    assert settings.sample_token == "local-value"
    assert settings.problems() == ()
    path.write_text("HYUNDAI_SAMPLE_TOKEN=${HOME}\n", encoding="utf-8")
    assert Settings.from_env_file(path).sample_token == "${HOME}"


def test_missing_file_does_not_read_other_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("HYUNDAI_SAMPLE_TOKEN", "process-value")
    assert Settings.from_env_file(tmp_path / "missing").sample_token == ""


@pytest.mark.parametrize("car", ["../wrong", "car?secret=x", "bad/car", "car#fragment"])
def test_invalid_car_id_cannot_change_request_target(car):
    result = run_sample(Settings("synthetic-token", car))
    assert result.status == Status.CONFIG_INVALID
    assert result.network_attempted is False


def test_settings_repr_never_contains_credentials():
    settings = Settings("local-secret-value", "local-car", client_secret="oauth-private")
    for value in settings.sensitive_values():
        assert value not in repr(settings)


def test_masks_known_secrets_bearer_and_url():
    text = "Bearer " + "synthetic-token" + " /car/status/private-car/odometer oauth-private"
    safe = redact(text, ("synthetic-token", "private-car", "oauth-private"))
    for value in ("synthetic-token", "private-car", "oauth-private"):
        assert value not in safe


def test_provider_error_echo_is_not_logged():
    private = "synthetic-private-value"
    result = run_mock({"errCode": private, "errMsg": private, "errId": private}, http_status=401)
    assert private not in result.safe_json()
    assert result.provider_error_code is None


def test_numeric_error_code_matching_secret_is_masked():
    result = run_mock({"errCode": "4011"}, http_status=401)
    text = result.safe_json(Settings("4011", "mock-car"))
    assert "4011" not in text
    assert json.loads(text)["provider_error_code"] == "[REDACTED]"


def test_scanner_detects_leak_without_printing_value(tmp_path):
    spec = importlib.util.spec_from_file_location(
        "scanner", PROJECT_ROOT / "scripts/check_secrets.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    private = "synthetic-private-" + "for-scanner"
    (tmp_path / ".env").write_text("HYUNDAI_SAMPLE_TOKEN=" + private, encoding="utf-8")
    (tmp_path / "accidental.txt").write_text(private, encoding="utf-8")
    report = module.scan_project(tmp_path)
    assert report["passed"] is False
    assert private not in json.dumps(report)
    assert any(item["rule"] == "matches_local_secret" for item in report["findings"])


def test_excluded_paths_are_declared():
    ignore = (PROJECT_ROOT / ".gitignore").read_text(encoding="utf-8")
    for name in (".env", ".venv/", ".python-runtime/", ".uv-cache/", "output/"):
        assert name in ignore.splitlines()


def test_no_sample_fixture_masquerading_as_live_data():
    files = list((PROJECT_ROOT / "fixtures/sample_responses").glob("*.json"))
    assert files == []


def test_repo_path_is_absolute():
    assert isinstance(PROJECT_ROOT, Path) and PROJECT_ROOT.is_absolute()
