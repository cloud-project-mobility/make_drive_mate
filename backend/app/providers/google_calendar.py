"""Read-only Calendar adapter; fixture contracts informed by the sibling experiment.

Provenance: cloud-project-mobility/google-calender-iljung-api-experiment,
examples/README.md and docs/reproduce.md. No credentials or observed event
contents are copied. Mock events below are newly authored synthetic examples.
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime, time, timedelta
from urllib.parse import quote
from zoneinfo import ZoneInfo

import httpx

from .common import Provider, ProviderMode, aware_datetime, require_text


def _date(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise ValueError("invalid date")
    date.fromisoformat(value)
    return value


def _timezone(value: object) -> str:
    zone = require_text(value, maximum=100)
    ZoneInfo(zone)
    return zone


def _instant(value: object, timezone: str | None) -> datetime:
    if not isinstance(value, str) or not re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]"
        r"(?:\.[0-9]{1,6})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])?",
        value,
    ):
        raise ValueError("invalid dateTime")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is not None and parsed.utcoffset() is not None:
        return parsed
    if not timezone:
        raise ValueError("dateTime needs offset or explicit timeZone")
    # Google can provide a local dateTime and an explicit timeZone. Reject
    # ambiguous/nonexistent local wall times instead of selecting a DST fold.
    zone = ZoneInfo(timezone)
    first, second = parsed.replace(tzinfo=zone, fold=0), parsed.replace(tzinfo=zone, fold=1)
    if first.utcoffset() != second.utcoffset():
        raise ValueError("ambiguous or nonexistent local time")
    if first.astimezone(UTC).astimezone(zone).replace(tzinfo=None) != parsed:
        raise ValueError("nonexistent local time")
    return first


class GoogleCalendarProvider(Provider):
    name = "google_calendar"

    def __init__(
        self,
        mode: ProviderMode = "disconnected",
        *,
        access_token: str | None = None,
        transport: httpx.BaseTransport | None = None,
        timeout_s: float = 10.0,
        max_pages: int = 20,
    ) -> None:
        super().__init__(mode, transport=transport, timeout_s=timeout_s)
        if type(max_pages) is not int or not 1 <= max_pages <= 100:
            raise ValueError("max_pages must be between 1 and 100")
        self._access_token = access_token
        self.max_pages = max_pages

    def list_events(
        self, time_min: datetime, time_max: datetime, *, calendar_id: str = "primary"
    ) -> dict:
        aware_datetime(time_min)
        aware_datetime(time_max)
        if time_min.astimezone(UTC) >= time_max.astimezone(UTC):
            raise ValueError("time_min must precede time_max")
        calendar_id = require_text(calendar_id, maximum=1024)
        token = self.credential(self._access_token)
        if self.mode == "mock" and self.transport is None:
            try:
                pages = [self._mock_page(time_min)]
            except (OverflowError, ValueError):
                raise ValueError("requested date is outside the mock calendar range") from None
        else:
            pages = None
        params = {
            "timeMin": time_min.isoformat(),
            "timeMax": time_max.isoformat(),
            "singleEvents": "true",
            "orderBy": "startTime",
            "showDeleted": "false",
            "maxResults": 250,
            "fields": (
                "timeZone,nextPageToken,"
                "items(id,summary,start,end,location,status,recurringEventId)"
            ),
        }
        events, seen_tokens, by_id = [], set(), {}
        cancelled = 0
        calendar_timezone = None
        try:
            for page_number in range(1, self.max_pages + 1):
                page = (
                    pages[0]
                    if pages
                    else self.get_json(
                        "https://www.googleapis.com/calendar/v3/calendars/"
                        f"{quote(calendar_id, safe='')}/events",
                        params=params,
                        headers={"Authorization": f"Bearer {token}"} if token else None,
                    )
                )
                timezone = _timezone(page["timeZone"])
                if calendar_timezone is not None and timezone != calendar_timezone:
                    raise ValueError("calendar timezone changed during pagination")
                calendar_timezone = timezone
                items = page["items"]
                if not isinstance(items, list) or len(items) > 2500:
                    raise ValueError("invalid events list")
                for item in items:
                    if not isinstance(item, dict):
                        raise ValueError("invalid event")
                    status = item.get("status", "confirmed")
                    if status == "cancelled":
                        cancelled += 1
                        continue
                    if status not in {"confirmed", "tentative"}:
                        raise ValueError("invalid event status")
                    event = self._event(item, timezone)
                    # Do not duplicate an event encountered at a page boundary.
                    previous = by_id.get(event["id"])
                    if previous is not None:
                        if previous != event:
                            raise ValueError("conflicting duplicate event")
                        continue
                    by_id[event["id"]] = event
                    if self._overlaps(event, time_min, time_max):
                        events.append(event)
                page_token = page.get("nextPageToken")
                if page_token is None:
                    return {
                        **self.metadata(),
                        "events": events,
                        "timezone": timezone,
                        "pages_fetched": page_number,
                        "cancelled_count": cancelled,
                        "complete": True,
                    }
                page_token = require_text(page_token, maximum=4096)
                if page_token in seen_tokens:
                    raise ValueError("repeated page token")
                seen_tokens.add(page_token)
                params["pageToken"] = page_token
            raise ValueError("pagination limit exceeded")
        except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
            raise self.malformed() from None

    def _event(self, item: dict, calendar_timezone: str) -> dict:
        event_id = require_text(item["id"], maximum=1024)
        title = require_text(item.get("summary", ""), maximum=4000, empty=True) or "(제목 없음)"
        raw_location = item.get("location")
        location = (
            require_text(raw_location, maximum=4000, empty=True) or None
            if raw_location is not None
            else None
        )
        start, end = item["start"], item["end"]
        if not isinstance(start, dict) or not isinstance(end, dict):
            raise ValueError("invalid event boundary")
        timezone = _timezone(start.get("timeZone", calendar_timezone))
        end_timezone = _timezone(end.get("timeZone", calendar_timezone))
        all_day = "date" in start
        if all_day:
            if "dateTime" in start or "dateTime" in end:
                raise ValueError("mixed all-day and timed boundaries")
            start_date, end_date = _date(start["date"]), _date(end["date"])
            if end_date <= start_date:
                raise ValueError("invalid all-day span")
            start_at = end_at = None
        else:
            if "date" in end:
                raise ValueError("mixed all-day and timed boundaries")
            # A calendar-wide timezone is not evidence for an offset-less
            # dateTime: the event boundary must declare its own timezone.
            start_time = _instant(start["dateTime"], start.get("timeZone"))
            end_time = _instant(end["dateTime"], end.get("timeZone"))
            if end_time.astimezone(UTC) <= start_time.astimezone(UTC):
                raise ValueError("invalid event time span")
            start_at, end_at = start_time.isoformat(), end_time.isoformat()
            start_date = end_date = None
        return {
            "id": event_id,
            "title": title,
            "start_at": start_at,
            "end_at": end_at,
            "start_date": start_date,
            "end_date": end_date,
            "all_day": all_day,
            "location": location,
            "timezone": timezone,
            "end_timezone": end_timezone,
            "route_eligible": not all_day and location is not None,
            "recurring_event_id": require_text(item["recurringEventId"], maximum=1024)
            if "recurringEventId" in item
            else None,
        }

    @staticmethod
    def _overlaps(event: dict, time_min: datetime, time_max: datetime) -> bool:
        if event["all_day"]:
            zone = ZoneInfo(event["timezone"])
            start = datetime.combine(date.fromisoformat(event["start_date"]), time.min, zone)
            end = datetime.combine(date.fromisoformat(event["end_date"]), time.min, zone)
        else:
            start, end = (
                datetime.fromisoformat(event["start_at"]),
                datetime.fromisoformat(event["end_at"]),
            )
        return end.astimezone(UTC) > time_min.astimezone(UTC) and start.astimezone(
            UTC
        ) < time_max.astimezone(UTC)

    @staticmethod
    def _mock_page(time_min: datetime) -> dict:
        zone = ZoneInfo("Asia/Seoul")
        next_day = time_min.astimezone(zone).date() + timedelta(days=1)
        start = datetime.combine(next_day, time(10), zone)
        end = start + timedelta(hours=1)
        return {
            "timeZone": "Asia/Seoul",
            "items": [
                {
                    "id": f"mock-meeting-{next_day}",
                    "summary": "[예시] 조별 프로젝트 회의",
                    "location": "서울시청",
                    "start": {"dateTime": start.isoformat()},
                    "end": {"dateTime": end.isoformat()},
                },
                {
                    "id": f"mock-all-day-{next_day}",
                    "summary": "[예시] 프로젝트 자료 정리",
                    "start": {"date": next_day.isoformat()},
                    "end": {"date": (next_day + timedelta(days=1)).isoformat()},
                },
                {
                    "id": f"mock-no-location-{next_day}",
                    "summary": "[예시] 온라인 회의 · 장소 없음",
                    "start": {"dateTime": (start + timedelta(hours=3)).isoformat()},
                    "end": {"dateTime": (end + timedelta(hours=3)).isoformat()},
                },
            ],
        }
