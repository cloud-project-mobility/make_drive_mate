"""Server validation of the app's v1 backup format and integration requests."""

import re
from datetime import datetime
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    field_validator,
    model_validator,
)

from .errors import AppError


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    @model_validator(mode="after")
    def client_string_length(self):
        # JavaScript string.length and native TextInput limits count UTF-16
        # code units; Python's default max_length counts Unicode code points.
        for name, model_field in type(self).model_fields.items():
            value = getattr(self, name)
            if not isinstance(value, str):
                continue
            limits = [
                item.max_length
                for item in model_field.metadata
                if getattr(item, "max_length", None) is not None
            ]
            if limits and len(value.encode("utf-16-le")) // 2 > min(limits):
                raise ValueError("Text exceeds the client UTF-16 length limit")
        return self


def timestamp(value: str) -> str:
    if not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", value
    ):
        raise ValueError("A timezone-aware ISO timestamp is required")
    if value[-1] != "Z" and (int(value[-5:-3]) > 23 or int(value[-2:]) > 59):
        raise ValueError("Invalid timezone offset")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timezone required")
    return value


class Credentials(Model):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=10, max_length=128)

    @field_validator("email")
    @classmethod
    def valid_email(cls, value: str) -> str:
        value = value.strip().casefold()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("Invalid email")
        return value


class Vehicle(Model):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=60)
    model: str = Field(min_length=1, max_length=100)
    powertrain: Literal["ICE", "HYB", "EV"]
    odometerKm: float = Field(ge=0, le=2_000_000, strict=True)
    createdAt: str

    _created = field_validator("createdAt")(timestamp)


class ActiveTrip(Model):
    id: str = Field(min_length=1, max_length=100)
    vehicleId: str = Field(min_length=1, max_length=100)
    startedAt: str
    distanceKm: float = Field(ge=0, le=10_000, strict=True)
    durationSeconds: float = Field(ge=0, le=604_800, strict=True)
    origin: str | None = Field(default=None, min_length=1, max_length=160)
    destination: str | None = Field(default=None, min_length=1, max_length=160)
    planId: str | None = Field(default=None, min_length=1, max_length=100)

    _started = field_validator("startedAt")(timestamp)


class Trip(ActiveTrip):
    endedAt: str
    source: Literal["gps", "manual", "sample"]

    _ended = field_validator("endedAt")(timestamp)

    @model_validator(mode="after")
    def duration_consistent(self) -> "Trip":
        elapsed = (
            datetime.fromisoformat(self.endedAt.replace("Z", "+00:00"))
            - datetime.fromisoformat(self.startedAt.replace("Z", "+00:00"))
        ).total_seconds()
        if elapsed < 0 or self.durationSeconds > elapsed + 2:
            raise ValueError("Trip duration exceeds elapsed time")
        return self


class Coordinate(Model):
    longitude: float = Field(ge=-180, le=180, strict=True)
    latitude: float = Field(ge=-90, le=90, strict=True)


class PlanRoute(Model):
    source: Literal["mock", "live"]
    computedAt: str
    expiresAt: str

    _computed = field_validator("computedAt")(timestamp)
    _expires = field_validator("expiresAt")(timestamp)

    @model_validator(mode="after")
    def valid_lifetime(self) -> "PlanRoute":
        if datetime.fromisoformat(self.expiresAt) <= datetime.fromisoformat(self.computedAt):
            raise ValueError("Route expiration must follow computation")
        return self


class Plan(Model):
    id: str = Field(min_length=1, max_length=100)
    vehicleId: str = Field(min_length=1, max_length=100)
    origin: str = Field(min_length=1, max_length=160)
    destination: str = Field(min_length=1, max_length=160)
    eventTitle: str | None = Field(default=None, min_length=1, max_length=100)
    eventAt: str | None = None
    driveMinutes: float = Field(ge=1, le=1440, strict=True)
    walkMinutes: float = Field(ge=0, le=180, strict=True)
    bufferMinutes: float = Field(ge=0, le=180, strict=True)
    distanceKm: float | None = Field(default=None, ge=0, le=10_000, strict=True)
    source: Literal["manual", "sample"]
    createdAt: str
    originPoint: Coordinate | None = None
    destinationPoint: Coordinate | None = None
    route: PlanRoute | None = None

    _created = field_validator("createdAt")(timestamp)

    @field_validator("eventAt")
    @classmethod
    def event_timestamp(cls, value: str | None) -> str | None:
        return timestamp(value) if value is not None else None

    @model_validator(mode="after")
    def route_consistent(self) -> "Plan":
        if self.route is not None:
            if any(
                value is None
                for value in (
                    self.originPoint,
                    self.destinationPoint,
                    self.distanceKm,
                    self.eventAt,
                )
            ):
                raise ValueError("A route needs coordinates, distance, and arrival time")
            if self.route.source == "mock" and self.source != "sample":
                raise ValueError("A mock route must remain a sample plan")
        return self


class Maintenance(Model):
    id: str = Field(min_length=1, max_length=100)
    vehicleId: str = Field(min_length=1, max_length=100)
    itemId: str = Field(min_length=1, max_length=100)
    odometerKm: float = Field(ge=0, le=2_000_000, strict=True)
    performedAt: str
    note: str | None = Field(default=None, min_length=1, max_length=500)

    _performed = field_validator("performedAt")(timestamp)


class Preferences(Model):
    walkMinutes: float = Field(ge=0, le=180, strict=True)
    bufferMinutes: float = Field(ge=0, le=180, strict=True)


class AppState(Model):
    version: Literal[1]
    vehicles: list[Vehicle] = Field(max_length=3)
    selectedVehicleId: str | None
    trips: list[Trip] = Field(max_length=20_000)
    plans: list[Plan] = Field(max_length=2_000)
    maintenance: list[Maintenance] = Field(max_length=20_000)
    activeTrip: ActiveTrip | None
    settings: Preferences
    onboarded: StrictBool
    demoMode: StrictBool

    @model_validator(mode="before")
    @classmethod
    def strict_text(cls, data):
        # Match the client's string rules; do not silently coerce or trim backup contents.
        def visit(value, key=""):
            if isinstance(value, dict):
                for k, v in value.items():
                    visit(v, k)
            elif isinstance(value, list):
                for item in value:
                    visit(item)
            elif isinstance(value, str):
                pattern = r"[\x00-\x08\x0b\x0c\x0e-\x1f]" if key == "note" else r"[\x00-\x1f]"
                if not value.strip() or re.search(pattern, value):
                    raise ValueError("Empty or control-character text")
            if (
                key
                in {
                    "origin",
                    "destination",
                    "eventTitle",
                    "eventAt",
                    "distanceKm",
                    "note",
                    "originPoint",
                    "destinationPoint",
                    "route",
                    "planId",
                }
                and value is None
            ):
                raise ValueError("Optional fields must be omitted rather than null")

        visit(data)
        if isinstance(data, dict) and type(data.get("version")) is not int:
            raise ValueError("Invalid schema version")
        return data

    @model_validator(mode="after")
    def consistent_references(self) -> "AppState":
        vehicles = {v.id: v for v in self.vehicles}
        for rows in [self.vehicles, self.trips, self.plans, self.maintenance]:
            if len({r.id for r in rows}) != len(rows):
                raise ValueError("Duplicate IDs")
        if self.selectedVehicleId not in vehicles and (
            vehicles or self.selectedVehicleId is not None
        ):
            raise ValueError("Selected vehicle not found")
        for row in [*self.trips, *self.plans, *self.maintenance]:
            if row.vehicleId not in vehicles:
                raise ValueError("Orphan vehicle reference")
        if self.activeTrip is not None:
            raise ValueError("Finish or cancel the active trip before cloud backup")
        for record in self.maintenance:
            vehicle = vehicles[record.vehicleId]
            items = {"tires", "brakes", "cabin-filter", "wipers"}
            items |= (
                {"cooling"} if vehicle.powertrain == "EV" else {"engine-oil", "engine-air-filter"}
            )
            if record.itemId not in items or record.odometerKm > vehicle.odometerKm:
                raise ValueError("Invalid maintenance record")
        if not self.onboarded:
            raise ValueError("Complete onboarding before cloud backup")
        return self

    def snapshot(self) -> dict:
        # App v1 distinguishes absent optional fields from null required references.
        data = self.model_dump(exclude_none=True)
        data["activeTrip"] = None
        data["selectedVehicleId"] = self.selectedVehicleId
        return data


class StateUpload(Model):
    expected_revision: Annotated[int, Field(ge=0, strict=True)]
    state: AppState


class RouteRequest(Model):
    origin: Coordinate
    destination: Coordinate
    arrival_at: str
    walk_minutes: float = Field(default=10, ge=0, le=180, strict=True)
    buffer_minutes: float = Field(default=10, ge=0, le=180, strict=True)

    _arrival = field_validator("arrival_at")(timestamp)

    def arrival(self) -> datetime:
        try:
            return datetime.fromisoformat(self.arrival_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise AppError("invalid_arrival", "도착 시각을 확인해 주세요.") from exc
