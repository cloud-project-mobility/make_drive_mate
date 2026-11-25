import copy
import json
from datetime import UTC, datetime

import pytest

from hyundai_experiments.catalog import APIS
from hyundai_experiments.client import run_mock
from hyundai_experiments.config import PROJECT_ROOT
from hyundai_experiments.errors import Status
from hyundai_experiments.status_models import WarningResponse, parse_status


@pytest.fixture
def statuses():
    return json.loads((PROJECT_ROOT / "fixtures/mock_responses/status.json").read_text())


@pytest.mark.parametrize("api", [name for name in APIS if name != "odometer"])
def test_each_documented_response(api, statuses):
    result = run_mock(statuses[api], api=api)
    assert result.status == Status.MOCK_VALIDATED
    assert result.diagnostic()["api"] == api
    assert result.network_attempted is False
    assert "msgId" not in result.safe_json()


@pytest.mark.parametrize("api", [name for name in APIS if name != "odometer"])
def test_null_never_becomes_normal_for_any_api(api):
    assert run_mock(None, api=api).status == Status.SCHEMA_UNVERIFIED


@pytest.mark.parametrize("value", [None, 0, 1, "false", "true", [], {}])
def test_warning_requires_real_boolean(value):
    result = run_mock({"msgId": "mock-warning", "status": value}, api="engine-oil")
    assert result.status == Status.SCHEMA_UNVERIFIED


def test_warning_false_has_no_invented_observation_time(statuses):
    result = parse_status("engine-oil", statuses["engine-oil"], datetime.now(UTC))
    assert isinstance(result, WarningResponse)
    assert result.status is False
    assert result.provider_observed_at is None


@pytest.mark.parametrize(
    "field,value",
    [
        ("batteryPlugin", 9),
        ("batteryPlugin", True),
        ("batteryCharge", 1),
        ("soc", 101),
        ("soc", -1),
        ("soc", None),
        ("remainTime", None),
        ("remainTime", {"unit": 1}),
        ("remainTime", {"value": 1, "unit": 88}),
        ("targetSOC", None),
        ("targetSOC", []),
        ("targetSOC", {}),
        ("targetSOC", {"plugType": 7}),
        ("targetSOC", {"targetSOClevel": 101}),
        ("timestamp", "unknown"),
    ],
)
def test_charging_invalid_fields_are_unverified(statuses, field, value):
    payload = copy.deepcopy(statuses["ev-charging"])
    payload[field] = value
    assert run_mock(payload, api="ev-charging").status == Status.SCHEMA_UNVERIFIED


def test_optional_charging_target_can_be_absent(statuses):
    del statuses["ev-charging"]["targetSOC"]
    assert run_mock(statuses["ev-charging"], api="ev-charging").validated


def test_phev_distance_requires_known_unit_when_value_present(statuses):
    payload = statuses["dte"]
    payload["phevTotalValue"] = 500
    assert not run_mock(payload, api="dte").validated
    payload["phevTotalUnit"] = 1
    assert run_mock(payload, api="dte").validated


def test_only_official_routes_are_allowlisted():
    assert len(APIS) == 10
    assert "carlist" not in APIS
    assert APIS["brake-oil"].path.endswith("/breakOil")
    assert all(
        spec.sample_url.startswith("https://dev.kr-ccapi.hyundai.com/api_sample/v1/")
        for spec in APIS.values()
    )
