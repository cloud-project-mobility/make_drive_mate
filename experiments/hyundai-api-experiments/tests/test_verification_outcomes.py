import importlib.util
from dataclasses import replace

import httpx
import pytest

from hyundai_experiments.client import run_mock, run_sample
from hyundai_experiments.config import PROJECT_ROOT, Settings
from hyundai_experiments.errors import Status


def test_missing_settings_are_not_a_failed_http_call():
    result = run_sample(Settings())
    assert result.diagnostic()["verification_outcome"] == "not_verified"
    assert result.http_status is None
    assert result.network_attempted is False


def test_mock_success_remains_mock(payload):
    result = run_mock(payload)
    assert result.validated
    assert result.diagnostic()["verification_outcome"] == "mock_only"


def test_explicit_body_failure_cannot_be_success(payload):
    payload["success"] = False
    result = run_mock(payload)
    assert result.status == Status.PROVIDER_ERROR
    assert result.data is None


@pytest.mark.parametrize(
    "code,expected",
    [
        ("4011", "invalid_authorization_header"),
        ("4012", "invalid_session"),
        ("unknown", "invalid_or_expired_not_distinguishable"),
    ],
)
def test_401_does_not_claim_confirmed_token_expiry(code, expected):
    result = run_mock({"errCode": code}, http_status=401)
    assert result.diagnostic()["authentication_cause"] == expected


def test_transport_failure_is_not_unsupported():
    result = replace(
        run_mock(error=httpx.ConnectError("synthetic")),
        source="SAMPLE",
        network_attempted=True,
    )
    assert result.diagnostic()["verification_outcome"] == "sample_failure"


def test_importer_network_error_is_classified_without_echo(monkeypatch, tmp_path, capsys):
    spec = importlib.util.spec_from_file_location(
        "importer_diagnostic_test", PROJECT_ROOT / "scripts" / "import_official_sample.py"
    )
    importer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(importer)

    monkeypatch.setattr(importer, "PROJECT_ROOT", tmp_path)

    def failed(*args, **kwargs):
        raise httpx.ConnectError("certificate_verify_failed synthetic-sensitive-value")

    monkeypatch.setattr(httpx.Client, "get", failed)
    assert importer.main() == 1
    text = capsys.readouterr().out
    assert '"error_category": "tls_error"' in text
    assert "synthetic-sensitive-value" not in text
