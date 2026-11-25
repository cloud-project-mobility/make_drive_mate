import json
import socket
import ssl

import httpx
import pytest

from hyundai_experiments.client import aggregate_results, run_mock, run_sample
from hyundai_experiments.config import Settings
from hyundai_experiments.errors import Status


def test_mock_is_clearly_offline(payload):
    result = run_mock(payload)
    assert result.status == Status.MOCK_VALIDATED
    assert result.network_attempted is False
    assert result.json_parsed is True
    assert result.structure_valid is True


@pytest.mark.parametrize(
    "http_status,expected",
    [
        (401, Status.AUTH_FAILED),
        (403, Status.FORBIDDEN),
        (429, Status.RATE_LIMITED),
        (500, Status.SERVER_ERROR),
        (503, Status.SERVER_ERROR),
        (400, Status.HTTP_ERROR),
        (302, Status.REDIRECT),
        (204, Status.HTTP_ERROR),
    ],
)
def test_http_error_classification(http_status, expected):
    result = run_mock({"errCode": "4002", "errMsg": "synthetic error"}, http_status=http_status)
    assert result.status == expected
    assert result.provider_error_code == "4002"
    assert result.data is None


def test_auth_failure_even_if_body_is_html():
    result = run_mock(http_status=401, body=b"<html>Unauthorized</html>")
    assert result.status == Status.AUTH_FAILED
    assert result.json_parsed is False


def test_invalid_json():
    result = run_mock(body=b"{broken")
    assert result.status == Status.INVALID_JSON
    assert result.json_parsed is False


@pytest.mark.parametrize("field", ["errCode", "errMsg", "errId", "error", "errors"])
def test_error_in_200_is_not_success(payload, field):
    payload[field] = "provider error"
    result = run_mock(payload)
    assert result.status == Status.PROVIDER_ERROR
    assert result.data is None


@pytest.mark.parametrize("payload", [None, {}, [], {"msgId": "mock", "odometers": []}])
def test_200_with_invalid_schema_is_unverified(payload):
    result = run_mock(payload)
    assert result.status == Status.SCHEMA_UNVERIFIED
    assert result.http_status == 200
    assert result.json_parsed is True
    assert result.structure_valid is False


@pytest.mark.parametrize(
    "error,expected",
    [
        (httpx.ReadTimeout("mock timeout"), Status.TIMEOUT),
        (httpx.ConnectError("getaddrinfo failed"), Status.DNS_ERROR),
        (httpx.ConnectError("certificate_verify_failed"), Status.TLS_ERROR),
        (httpx.ConnectError("connection refused"), Status.CONNECTION_ERROR),
    ],
)
def test_network_failure_is_never_replaced_by_mock_success(error, expected):
    result = run_mock(error=error)
    assert result.status == expected
    assert result.data is None
    assert result.http_status is None
    assert result.json_parsed is None


@pytest.mark.parametrize(
    "cause,expected",
    [
        (socket.gaierror(11001, "synthetic"), Status.DNS_ERROR),
        (ssl.SSLCertVerificationError("synthetic"), Status.TLS_ERROR),
    ],
)
def test_error_cause_chain(cause, expected):
    error = httpx.ConnectError("masked wrapper")
    error.__cause__ = cause
    assert run_mock(error=error).status == expected


def test_missing_config_never_opens_client(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Client constructed without config")

    monkeypatch.setattr(httpx, "Client", forbidden)
    result = run_sample(Settings())
    assert result.status == Status.CONFIG_MISSING
    assert not result.network_attempted


def test_exactly_one_get_no_redirect_no_secret_and_no_proxy(monkeypatch, payload):
    requests = []
    options = {}
    original = httpx.Client
    settings = Settings("synthetic-token", "synthetic-car", client_secret="unused-oauth-secret")

    def handler(request):
        requests.append(request)
        return httpx.Response(302, headers={"Location": "https://other.invalid/"}, json=payload)

    def offline_client(**kwargs):
        options.update(kwargs)
        kwargs["transport"] = httpx.MockTransport(handler)
        return original(**kwargs)

    monkeypatch.setattr(httpx, "Client", offline_client)
    result = run_sample(settings)
    assert result.status == Status.REDIRECT
    assert len(requests) == 1
    request = requests[0]
    assert request.method == "GET"
    assert request.url.host == "dev.kr-ccapi.hyundai.com"
    assert request.url.path == "/api_sample/v1/car/status/synthetic-car/odometer"
    assert request.headers["Authorization"] == "Bearer " + settings.sample_token
    assert request.headers["Accept"] == "application/json"
    assert settings.client_secret not in str(request.headers)
    assert options["follow_redirects"] is False
    assert options["trust_env"] is False
    assert options["verify"] is True


def test_partial_failure_preserves_results(payload):
    good, bad = run_mock(payload), run_mock(http_status=403)
    assert aggregate_results([good, bad]) == "partial_failure"
    assert bad.data is None
    assert aggregate_results([]) == "not_verified"
    assert aggregate_results([bad]) == "all_failed"
    assert aggregate_results([good]) == "all_validated"


def test_diagnostics_never_serialize_vehicle_payload(payload):
    result = run_mock(payload)
    text = result.safe_json()
    doc = json.loads(text)
    assert "data" not in doc
    assert "45678" not in text
    assert payload["msgId"] not in text
    assert "Authorization" not in text
    assert "response_body_saved" in text
