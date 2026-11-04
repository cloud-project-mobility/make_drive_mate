from copy import deepcopy
from datetime import UTC, datetime

import httpx
import pytest

from app.providers import GoogleCalendarProvider, HyundaiProvider, KakaoProvider, ProviderError
from app.providers.hyundai import normalize_odometer
from app.providers.kakao import MOCK_PLACES, coordinate

START = datetime(2026, 10, 28, tzinfo=UTC)
END = datetime(2026, 11, 1, tzinfo=UTC)
ORIGIN = coordinate(MOCK_PLACES[0])
DESTINATION = coordinate(MOCK_PLACES[1])


def local_payload():
    return {
        "meta": {"total_count": 1, "pageable_count": 1, "is_end": True},
        "documents": [
            {
                "id": "place-1",
                "place_name": "테스트 장소",
                "address_name": "테스트 주소",
                "x": "127.01",
                "y": "37.51",
            }
        ],
    }


def route_payload():
    return {
        "routes": [
            {
                "result_code": 0,
                "summary": {
                    "distance": 1234,
                    "duration": 567,
                    "priority": "RECOMMEND",
                    "origin": {"x": 126.9726, "y": 37.5547},
                    "destination": {"x": 126.9784, "y": 37.5666},
                },
                "sections": [
                    {
                        "distance": 1234,
                        "duration": 560,
                        "roads": [{"vertexes": [126.9726, 37.5547, 126.9784, 37.5666]}],
                    }
                ],
            }
        ],
    }


def timed_event(**overrides):
    return {
        "id": "event-1",
        "summary": "테스트 회의",
        "location": "서울시청",
        "start": {"dateTime": "2026-10-29T10:00:00+09:00"},
        "end": {"dateTime": "2026-10-29T11:00:00+09:00"},
        **overrides,
    }


def calendar_payload(*events, **extra):
    return {"timeZone": "Asia/Seoul", "items": list(events), **extra}


def response_transport(payload, *, status=200, headers=None):
    return httpx.MockTransport(
        lambda request: httpx.Response(status, json=payload, headers=headers)
    )


@pytest.mark.parametrize(
    "provider,operation",
    [
        (KakaoProvider(), lambda provider: provider.search("서울")),
        (GoogleCalendarProvider(), lambda provider: provider.list_events(START, END)),
        (HyundaiProvider(), lambda provider: provider.vehicle_status()),
    ],
)
def test_default_is_disconnected(provider, operation):
    with pytest.raises(ProviderError) as error:
        operation(provider)
    assert error.value.code == "provider_disconnected"
    assert error.value.http_status == 503


@pytest.mark.parametrize(
    "provider,operation",
    [
        (KakaoProvider("live"), lambda provider: provider.search("서울")),
        (KakaoProvider("live"), lambda provider: provider.route(ORIGIN, DESTINATION)),
        (GoogleCalendarProvider("live"), lambda provider: provider.list_events(START, END)),
        (HyundaiProvider("live"), lambda provider: provider.vehicle_status()),
    ],
)
def test_live_unconfigured_never_falls_back_to_samples(provider, operation):
    with pytest.raises(ProviderError) as error:
        operation(provider)
    assert error.value.code == "provider_not_configured"


def test_mock_modes_need_neither_credentials_nor_network(monkeypatch):
    monkeypatch.setenv("KAKAO_REST_API_KEY", "unread-environment-value")
    monkeypatch.setenv("GOOGLE_ACCESS_TOKEN", "unread-environment-value")
    kakao = KakaoProvider("mock")
    places = kakao.search("서울")
    assert places["source"] == "mock" and len(places["places"]) == 3
    assert kakao.search("없는장소")["places"] == []
    assert kakao.search("서울", size=1)["is_end"] is False
    assert kakao.search("서울", size=1, page=3)["is_end"] is True
    assert kakao.geocode("세종대로")["places"][0]["name"] == "서울시청"
    route = kakao.route(ORIGIN, DESTINATION)
    assert route["source"] == "mock" and route["distance_m"] == 2400
    assert route["geometry"][0] == ORIGIN
    reverse = kakao.route(DESTINATION, ORIGIN)
    assert reverse["geometry"] == list(reversed(route["geometry"]))
    assert kakao.route(ORIGIN, coordinate(MOCK_PLACES[2]))["distance_m"] == 12500
    with pytest.raises(ProviderError, match="서울역") as error:
        kakao.route(ORIGIN, {"longitude": 127.1, "latitude": 37.6})
    assert error.value.code == "mock_route_unavailable"
    events = GoogleCalendarProvider("mock").list_events(START, END)["events"]
    assert len(events) == 3
    assert sum(event["route_eligible"] for event in events) == 1
    assert HyundaiProvider("mock").vehicle_status()["source"] == "mock"


def test_kakao_preserves_units_geometry_and_summary_duration():
    provider = KakaoProvider("mock", transport=response_transport(route_payload()))
    result = provider.route(ORIGIN, DESTINATION)
    assert result["distance_m"] == 1234
    assert result["duration_s"] == 567
    assert result["sections"] == [{"distance_m": 1234, "duration_s": 560}]
    assert result["geometry"] == [ORIGIN, DESTINATION]


def test_kakao_fixed_hosts_and_rest_key_fallback_with_no_live_evidence():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(
            200, json=route_payload() if "directions" in request.url.path else local_payload()
        )

    provider = KakaoProvider(
        "live", rest_key="synthetic-token", transport=httpx.MockTransport(handler)
    )
    assert provider.search("서울")["source"] == "mock"
    assert provider.geocode("서울")["places"][0]["id"] == "address:127.01,37.51"
    assert provider.route(ORIGIN, DESTINATION)["source"] == "mock"
    assert {request.url.host for request in requests} == {
        "dapi.kakao.com",
        "apis-navi.kakaomobility.com",
    }
    assert all(
        request.headers["Authorization"] == "KakaoAK synthetic-token" for request in requests
    )
    assert requests[-1].url.params["origin"] == "126.9726,37.5547"


def test_route_failure_is_not_http_success_or_straight_line_fallback():
    provider = KakaoProvider(
        "mock",
        transport=response_transport(
            {"routes": [{"result_code": 104, "result_msg": "private message"}]}
        ),
    )
    with pytest.raises(ProviderError) as error:
        provider.route(ORIGIN, DESTINATION)
    assert error.value.code == "route_unavailable"
    assert "private" not in str(error.value)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda data: data["routes"][0].update(result_code=True),
        lambda data: data["routes"][0]["summary"].update(distance=-1),
        lambda data: data["routes"][0]["summary"].update(duration=True),
        lambda data: data["routes"][0].update(sections=[]),
        lambda data: data["routes"][0]["sections"][0]["roads"][0].update(vertexes=[127]),
        lambda data: data["routes"][0]["sections"][0]["roads"][0].update(
            vertexes=[float("nan"), 37]
        ),
        lambda data: data["routes"][0]["summary"].update(priority="UNKNOWN"),
    ],
)
def test_malformed_route_never_returns_an_eta(mutation):
    payload = route_payload()
    mutation(payload)
    # Content intentionally allows nonstandard NaN for strict parser verification.
    import json

    provider = KakaoProvider(
        "mock",
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, content=json.dumps(payload))
        ),
    )
    with pytest.raises(ProviderError) as error:
        provider.route(ORIGIN, DESTINATION)
    assert error.value.code == "provider_malformed_response"


@pytest.mark.parametrize(
    "mutation",
    [
        lambda data: data["meta"].update(is_end=1),
        lambda data: data["meta"].update(total_count=True),
        lambda data: data["documents"][0].update(x="nan"),
        lambda data: data["documents"][0].update(y=True),
        lambda data: data.update(documents={}),
    ],
)
def test_malformed_places_are_rejected(mutation):
    payload = local_payload()
    mutation(payload)
    with pytest.raises(ProviderError) as error:
        KakaoProvider("mock", transport=response_transport(payload)).search("서울")
    assert error.value.code == "provider_malformed_response"


@pytest.mark.parametrize(
    "operation",
    [
        lambda: KakaoProvider("mock").search(""),
        lambda: KakaoProvider("mock").search("서울", page=True),
        lambda: KakaoProvider("mock").search("서울", size=16),
        lambda: KakaoProvider("mock").route(
            {"longitude": float("inf"), "latitude": 37}, DESTINATION
        ),
        lambda: KakaoProvider("mock").route({"longitude": True, "latitude": 37}, DESTINATION),
        lambda: KakaoProvider("mock").route(ORIGIN, DESTINATION, priority="FASTEST"),
    ],
)
def test_invalid_kakao_inputs_do_not_open_transport(operation):
    with pytest.raises(ValueError):
        operation()


@pytest.mark.parametrize(
    "status,code,retryable",
    [
        (401, "provider_authorization_required", False),
        (403, "provider_authorization_required", False),
        (429, "provider_rate_limited", True),
        (500, "provider_http_error", True),
        (302, "provider_http_error", False),
    ],
)
def test_http_errors_are_safe_and_not_retried(status, code, retryable):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(
            status,
            json={"secret": "must-not-leak"},
            headers={"Retry-After": "99999", "Location": "https://unexpected.invalid/secret"},
        )

    with pytest.raises(ProviderError) as error:
        KakaoProvider("mock", transport=httpx.MockTransport(handler)).search("서울")
    assert len(requests) == 1
    assert error.value.code == code and error.value.retryable is retryable
    assert "must-not-leak" not in str(error.value)
    if status == 429:
        assert error.value.retry_after_s == 120.0


@pytest.mark.parametrize(
    "exception,code,status",
    [
        (httpx.ReadTimeout("private request details"), "provider_timeout", 504),
        (httpx.ConnectError("private request details"), "provider_unavailable", 502),
    ],
)
def test_transport_failures_are_classified_and_redacted(exception, code, status):
    def fail(request):
        raise exception

    with pytest.raises(ProviderError) as error:
        GoogleCalendarProvider("mock", transport=httpx.MockTransport(fail)).list_events(START, END)
    assert error.value.code == code and error.value.http_status == status
    assert "private request details" not in str(error.value)


@pytest.mark.parametrize("content", [b"not json", b"[]", b'{"error":{"message":"secret"}}'])
def test_invalid_json_and_success_error_envelopes(content):
    provider = KakaoProvider(
        "mock", transport=httpx.MockTransport(lambda request: httpx.Response(200, content=content))
    )
    with pytest.raises(ProviderError) as error:
        provider.search("서울")
    assert error.value.code in {"provider_malformed_response", "provider_rejected"}
    assert "secret" not in str(error.value)


def test_calendar_paginates_even_empty_pages_and_preserves_edge_cases():
    requests = []
    all_day = {
        "id": "all-day",
        "summary": "종일",
        "start": {"date": "2026-10-29"},
        "end": {"date": "2026-10-31"},
    }
    missing_location = timed_event(id="no-location", location=None, recurringEventId="series-1")
    pages = [
        calendar_payload(nextPageToken="page-2"),
        calendar_payload(
            timed_event(), all_day, missing_location, {"id": "cancelled", "status": "cancelled"}
        ),
    ]

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=pages[len(requests) - 1])

    result = GoogleCalendarProvider("mock", transport=httpx.MockTransport(handler)).list_events(
        START, END, calendar_id="name@example.test"
    )
    assert result["pages_fetched"] == 2 and result["cancelled_count"] == 1
    assert len(result["events"]) == 3
    assert requests[1].url.params["pageToken"] == "page-2"
    assert requests[0].url.params["singleEvents"] == "true"
    assert requests[0].url.params["orderBy"] == "startTime"
    timed, whole_day, without_place = result["events"]
    assert timed["start_at"] == "2026-10-29T10:00:00+09:00"
    assert timed["route_eligible"] is True
    assert whole_day["start_at"] is None and whole_day["end_at"] is None
    assert whole_day["start_date"] == "2026-10-29" and whole_day["end_date"] == "2026-10-31"
    assert whole_day["route_eligible"] is False
    assert without_place["location"] is None and without_place["route_eligible"] is False
    assert without_place["recurring_event_id"] == "series-1"


def test_calendar_interval_edges_and_offsetless_explicit_timezone():
    item = timed_event(
        start={"dateTime": "2026-10-29T10:00:00", "timeZone": "Asia/Seoul"},
        end={"dateTime": "2026-10-29T11:00:00", "timeZone": "Asia/Seoul"},
    )
    provider = GoogleCalendarProvider("mock", transport=response_transport(calendar_payload(item)))
    assert provider.list_events(START, END)["events"][0]["start_at"] == "2026-10-29T10:00:00+09:00"
    boundary = datetime.fromisoformat("2026-10-29T11:00:00+09:00")
    assert provider.list_events(boundary, END)["events"] == []
    boundary = datetime.fromisoformat("2026-10-29T10:00:00+09:00")
    assert provider.list_events(START, boundary)["events"] == []


def test_all_day_exclusive_end_date_is_not_an_extra_day():
    item = {"id": "all-day", "start": {"date": "2026-10-29"}, "end": {"date": "2026-10-30"}}
    provider = GoogleCalendarProvider("mock", transport=response_transport(calendar_payload(item)))
    start = datetime.fromisoformat("2026-10-30T00:00:00+09:00")
    assert provider.list_events(start, END)["events"] == []


@pytest.mark.parametrize(
    "item",
    [
        timed_event(start={"dateTime": "2026-10-29T10:00:00"}),
        timed_event(start={"dateTime": "2026-11-01T01:30:00", "timeZone": "America/New_York"}),
        timed_event(start={"dateTime": "2026-03-08T02:30:00", "timeZone": "America/New_York"}),
        timed_event(start={"date": "2026-10-29"}),
        timed_event(end={"dateTime": "2026-10-28T11:00:00+09:00"}),
        timed_event(start={"dateTime": "2026-10-29T10:00:00+09:00", "timeZone": "Unknown/Zone"}),
        timed_event(id=""),
        timed_event(status="unknown"),
    ],
)
def test_calendar_malformed_events_fail_without_inventing_times(item):
    with pytest.raises(ProviderError) as error:
        GoogleCalendarProvider(
            "mock", transport=response_transport(calendar_payload(item))
        ).list_events(START, END)
    assert error.value.code == "provider_malformed_response"


def test_calendar_token_cycle_and_page_cap_are_not_partial_success():
    transport = response_transport(calendar_payload(timed_event(), nextPageToken="same-token"))
    with pytest.raises(ProviderError):
        GoogleCalendarProvider("mock", transport=transport).list_events(START, END)
    with pytest.raises(ProviderError):
        GoogleCalendarProvider("mock", transport=transport, max_pages=1).list_events(START, END)


def test_calendar_duplicate_ids_do_not_duplicate_plans():
    payload = calendar_payload(timed_event(), timed_event())
    assert (
        len(
            GoogleCalendarProvider("mock", transport=response_transport(payload)).list_events(
                START, END
            )["events"]
        )
        == 1
    )
    payload["items"][1]["summary"] = "conflicting event"
    with pytest.raises(ProviderError):
        GoogleCalendarProvider("mock", transport=response_transport(payload)).list_events(
            START, END
        )


def test_hyundai_status_preserves_unknown_observation_time_and_separate_odometer():
    provider = HyundaiProvider("mock")
    first = provider.vehicle_status("vehicle-1")
    second = provider.vehicle_status("vehicle-1")
    assert first["odometer_km"] == second["odometer_km"] == 12500
    assert first["observed_at"] is None and first["provider_timezone"] is None
    assert first["provider_timestamp_raw"] == "20261028090000"
    assert datetime.fromisoformat(first["received_at"]).tzinfo is not None
    assert first["odometer_readings"][0]["unit"] == "km"
    assert first["odometer_policy"] == "absolute_provider_reading_do_not_add_trip_distance"
    assert "healthy" not in first and first["warnings_observed_at"] is None
    assert provider.vehicle_status(powertrain="ICE")["battery_percent"] is None
    assert provider.vehicle_status(powertrain="HYB")["battery_percent"] is None


@pytest.mark.parametrize(
    "timestamp",
    [
        "2026-10-29T10:00:00+09:99",
        "2026-10-29T10:00:00+25:00",
        "2026-10-29T25:00:00+09:00",
        "2026-10-29T10:60:00+09:00",
        "2026-10-29T10:00:60+09:00",
        "20261029T100000+0900",
    ],
)
def test_calendar_rejects_offsets_or_times_python_would_normalize(timestamp):
    item = timed_event(start={"dateTime": timestamp})
    with pytest.raises(ProviderError) as error:
        GoogleCalendarProvider(
            "mock", transport=response_transport(calendar_payload(item))
        ).list_events(START, END)
    assert error.value.code == "provider_malformed_response"


def test_mock_calendar_end_of_datetime_range_is_invalid_input():
    with pytest.raises(ValueError, match="mock calendar range"):
        GoogleCalendarProvider("mock").list_events(
            datetime(9999, 12, 31, tzinfo=UTC), datetime.max.replace(tzinfo=UTC)
        )


def test_hyundai_converted_distance_must_remain_finite():
    payload = {
        "msgId": "test",
        "odometers": [
            {"date": "20261028", "timestamp": "20261028090000", "value": 1.7e308, "unit": 3}
        ],
    }
    with pytest.raises(ProviderError):
        normalize_odometer(payload, START)


@pytest.mark.parametrize(
    "unit,value,expected", [(0, 1000, 0.3048), (1, 1000, 1000), (2, 1000, 1), (3, 1000, 1609.344)]
)
def test_hyundai_explicit_distance_conversion_preserves_raw(unit, value, expected):
    payload = {
        "msgId": "test",
        "odometers": [
            {"date": "20261028", "timestamp": "20261028090000", "value": value, "unit": unit}
        ],
    }
    result = normalize_odometer(payload, START)
    assert result["odometer_km"] == pytest.approx(expected)
    assert result["odometer_readings"][0]["value"] == str(value)
    assert result["odometer_readings"][0]["unit_code"] == unit


@pytest.mark.parametrize(
    "field,value",
    [
        ("value", True),
        ("value", -1),
        ("value", float("nan")),
        ("unit", True),
        ("unit", 4),
        ("timestamp", "20260230090000"),
        ("date", "20260230"),
    ],
)
def test_hyundai_rejects_invalid_rows_instead_of_partial_data(field, value):
    row = {"date": "20261028", "timestamp": "20261028090000", "value": 10, "unit": 1}
    invalid = deepcopy(row)
    invalid[field] = value
    with pytest.raises(ProviderError):
        normalize_odometer({"msgId": "test", "odometers": [row, invalid]}, START)


def test_hyundai_latest_measurement_does_not_depend_on_response_order():
    latest = {"date": "20261028", "timestamp": "20261028090000", "value": 200, "unit": 1}
    earlier = {"date": "20261027", "timestamp": "20261027090000", "value": 100, "unit": 1}
    result = normalize_odometer({"msgId": "test", "odometers": [latest, earlier]}, START)
    assert result["odometer_km"] == 200
    assert len(result["odometer_readings"]) == 2


def test_hyundai_rejects_naive_received_time():
    payload = {
        "msgId": "test",
        "odometers": [{"date": "20261028", "timestamp": "20261028090000", "value": 100, "unit": 1}],
    }
    with pytest.raises(ProviderError):
        normalize_odometer(payload, datetime(2026, 10, 28))
