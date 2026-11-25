"""Exactly one GET; verified TLS, no environment proxy, redirects or retries."""

import json
import re
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from time import perf_counter
from typing import Literal

import httpx

from .catalog import APIS
from .config import Settings
from .errors import SchemaError, Status, transport_status
from .redaction import redact
from .status_models import ApiResponse, parse_status

HOST = "dev.kr-ccapi.hyundai.com"
URL_TEMPLATE = f"https://{HOST}/api_sample/v1/car/status/{{car_id}}/odometer"
UNVERIFIED = (
    "real_vehicle_integration",
    "provider_timezone",
    "sample_cache_and_storage_permission",
    "external_ai_transfer_permission",
    "sample_rate_limit",
    "freshness_on_real_vehicle",
)


@dataclass(frozen=True)
class ExperimentResult:
    source: Literal["SAMPLE", "MOCK"]
    status: Status
    started_at: datetime
    received_at: datetime | None = None
    network_attempted: bool = False
    http_status: int | None = None
    provider_error_code: str | None = None
    elapsed_ms: float | None = None
    json_parsed: bool | None = None
    structure_valid: bool | None = None
    issues: tuple[str, ...] = ()
    data: ApiResponse | None = field(default=None, repr=False)
    api: str = "odometer"

    @property
    def validated(self) -> bool:
        return self.status in (Status.SAMPLE_VALIDATED, Status.MOCK_VALIDATED)

    def diagnostic(self) -> dict[str, object]:
        """Explicit allowlist: no data, identities, headers or error messages."""
        outcome = (
            "mock_only"
            if self.source == "MOCK"
            else "sample_success"
            if self.status == Status.SAMPLE_VALIDATED
            else "sample_unsupported"
            if self.status == Status.SAMPLE_UNSUPPORTED_CONFIRMED
            else "sample_failure"
            if self.network_attempted
            else "not_verified"
        )
        return {
            "api": self.api,
            "source": self.source,
            "status": self.status.value,
            "verification_outcome": outcome,
            "authentication_cause": (
                {"4011": "invalid_authorization_header", "4012": "invalid_session"}.get(
                    self.provider_error_code, "invalid_or_expired_not_distinguishable"
                )
                if self.status == Status.AUTH_FAILED
                else None
            ),
            "started_at": self.started_at.isoformat(),
            "received_at": self.received_at.isoformat() if self.received_at else None,
            "request": {
                "method": "GET",
                "url": (
                    APIS[self.api].sample_url.replace("{car_id}", "[REDACTED]")
                    if self.source == "SAMPLE"
                    else f"https://mock.invalid/{self.api}"
                ),
                "accept": "application/json",
            },
            "network_attempted": self.network_attempted,
            "http_status": self.http_status,
            "provider_error_code": self.provider_error_code,
            "elapsed_ms": self.elapsed_ms,
            "json_parsed": self.json_parsed,
            "structure_valid": self.structure_valid,
            "validation_basis": (
                "public_success_example_array; docs table says object"
                if self.api == "odometer"
                else "official_required_fields_and_documented_types"
            ),
            "specification": "https://developers.hyundai.com/web/v1/hyundai/specification/data/"
            + APIS[self.api].document,
            "issues": list(self.issues),
            "unverified": list(UNVERIFIED),
            "response_body_saved": False,
        }

    def safe_json(self, settings: Settings | None = None) -> str:
        # Redact string values before serializing to preserve valid JSON even if
        # a configured sensitive value happens to contain quotes or backslashes.
        secrets = settings.sensitive_values() if settings else ()

        def clean(value: object) -> object:
            if isinstance(value, str):
                return redact(value, secrets)
            if isinstance(value, dict):
                return {key: clean(item) for key, item in value.items()}
            if isinstance(value, list):
                return [clean(item) for item in value]
            return value

        return json.dumps(clean(self.diagnostic()), ensure_ascii=False, indent=2)


def configuration_result(settings: Settings) -> ExperimentResult | None:
    issues = settings.problems()
    if not issues:
        return None
    status = (
        Status.CONFIG_MISSING
        if any(i.endswith(":missing") for i in issues)
        else Status.CONFIG_INVALID
    )
    return ExperimentResult("SAMPLE", status, datetime.now(UTC), issues=issues)


def _classify_response(
    response: httpx.Response,
    source: Literal["SAMPLE", "MOCK"],
    started_at: datetime,
    elapsed_ms: float,
    api: str = "odometer",
) -> ExperimentResult:
    received_at = datetime.now(UTC)
    base = dict(
        source=source,
        api=api,
        started_at=started_at,
        received_at=received_at,
        elapsed_ms=elapsed_ms,
        network_attempted=source == "SAMPLE",
        http_status=response.status_code,
    )
    try:
        payload = response.json()
        base["json_parsed"] = True
    except (ValueError, UnicodeError):
        payload = None
        base["json_parsed"] = False
    code = payload.get("errCode") if isinstance(payload, dict) else None
    # Provider documents errCode as a four-digit string. Arbitrary strings may
    # echo credentials; record only the documented code shape, never errMsg/id.
    if isinstance(code, str) and re.fullmatch(r"(?:[45][0-9]{3}|9999)", code):
        base["provider_error_code"] = code
    http_status = response.status_code
    status = {401: Status.AUTH_FAILED, 403: Status.FORBIDDEN, 429: Status.RATE_LIMITED}.get(
        http_status
    )
    if status:
        return ExperimentResult(status=status, **base)
    if 500 <= http_status <= 599:
        return ExperimentResult(status=Status.SERVER_ERROR, **base)
    if 300 <= http_status <= 399:
        return ExperimentResult(status=Status.REDIRECT, **base)
    if http_status != 200:
        return ExperimentResult(status=Status.HTTP_ERROR, **base)
    if not base["json_parsed"]:
        return ExperimentResult(status=Status.INVALID_JSON, structure_valid=False, **base)
    if isinstance(payload, dict) and (
        any(key in payload for key in ("errCode", "errMsg", "errId", "error", "errors"))
        or payload.get("success") is False
    ):
        return ExperimentResult(status=Status.PROVIDER_ERROR, structure_valid=False, **base)
    try:
        data = parse_status(api, payload, received_at)
    except SchemaError as exc:
        return ExperimentResult(
            status=Status.SCHEMA_UNVERIFIED, structure_valid=False, issues=(str(exc),), **base
        )
    return ExperimentResult(
        status=Status.SAMPLE_VALIDATED if source == "SAMPLE" else Status.MOCK_VALIDATED,
        structure_valid=True,
        data=data,
        **base,
    )


def run_sample(settings: Settings, api: str = "odometer") -> ExperimentResult:
    """Live transport has no dependency-injection option that could disguise a mock."""
    spec = APIS[api]
    problem = configuration_result(settings)
    if problem:
        return replace(problem, api=api)
    started_at, start = datetime.now(UTC), perf_counter()
    try:
        with httpx.Client(
            timeout=httpx.Timeout(15, connect=10),
            verify=True,
            trust_env=False,
            follow_redirects=False,
            transport=httpx.HTTPTransport(retries=0, verify=True, trust_env=False),
        ) as client:
            response = client.get(
                spec.sample_url.format(car_id=settings.sample_car_id),
                headers={
                    "Authorization": "Bearer " + settings.sample_token,
                    "Accept": "application/json",
                },
            )
    except httpx.RequestError as exc:
        return ExperimentResult(
            "SAMPLE",
            transport_status(exc),
            started_at,
            api=api,
            network_attempted=True,
            elapsed_ms=round((perf_counter() - start) * 1000, 2),
        )
    return _classify_response(
        response, "SAMPLE", started_at, round((perf_counter() - start) * 1000, 2), api
    )


def run_mock(
    payload: object = None,
    *,
    http_status: int = 200,
    body: bytes | None = None,
    error: httpx.RequestError | None = None,
    api: str = "odometer",
) -> ExperimentResult:
    """Local transport only; synthetic response can never be labelled SAMPLE."""

    def handler(request: httpx.Request) -> httpx.Response:
        if error is not None:
            raise error
        if body is not None:
            return httpx.Response(http_status, content=body)
        return httpx.Response(
            http_status,
            content=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )

    started_at, start = datetime.now(UTC), perf_counter()
    try:
        with httpx.Client(
            transport=httpx.MockTransport(handler), trust_env=False, follow_redirects=False
        ) as client:
            response = client.get(f"https://mock.invalid/{api}")
    except httpx.RequestError as exc:
        return ExperimentResult(
            "MOCK",
            transport_status(exc),
            started_at,
            api=api,
            elapsed_ms=round((perf_counter() - start) * 1000, 2),
        )
    return _classify_response(
        response, "MOCK", started_at, round((perf_counter() - start) * 1000, 2), api
    )


def aggregate_results(results: list[ExperimentResult]) -> str:
    """Keeps each API result independent when DriveMate later adds more APIs."""
    if not results:
        return "not_verified"
    successes = sum(result.validated for result in results)
    if successes == len(results):
        return "all_validated"
    return "partial_failure" if successes else "all_failed"
