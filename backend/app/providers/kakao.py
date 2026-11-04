"""Kakao contracts adapted from cloud-project-mobility/kakao-map-api-experiments.

The original experiment established coordinate order, integer metres/seconds,
HTTP vs route result checks, and fixed credential destinations. Fixtures below
are newly authored synthetic examples, not captured provider responses.
"""

from __future__ import annotations

import math
from typing import Any

import httpx

from .common import Provider, ProviderError, ProviderMode, nonnegative_int, require_text

LOCAL = "https://dapi.kakao.com/v2/local"
DIRECTIONS = "https://apis-navi.kakaomobility.com/v1/directions"
MOCK_PLACES = (
    {
        "id": "mock-seoul-station",
        "name": "서울역",
        "address": "서울 중구 한강대로 405",
        "longitude": 126.9726,
        "latitude": 37.5547,
    },
    {
        "id": "mock-seoul-city-hall",
        "name": "서울시청",
        "address": "서울 중구 세종대로 110",
        "longitude": 126.9784,
        "latitude": 37.5666,
    },
    {
        "id": "mock-gangnam-station",
        "name": "강남역",
        "address": "서울 강남구 강남대로 396",
        "longitude": 127.0276,
        "latitude": 37.4979,
    },
)


def coordinate(value: Any) -> dict:
    if not isinstance(value, dict):
        raise ValueError("coordinate must be an object")
    result = {}
    for key, bound in (("longitude", 180), ("latitude", 90)):
        number = value[key]
        if (
            type(number) not in (int, float)
            or not math.isfinite(number)
            or not -bound <= number <= bound
        ):
            raise ValueError("invalid coordinate")
        result[key] = number
    return result


def provider_point(value: Any) -> dict:
    if (
        not isinstance(value, dict)
        or isinstance(value.get("x"), bool)
        or isinstance(value.get("y"), bool)
    ):
        raise ValueError("invalid provider coordinate")
    return coordinate({"longitude": float(value["x"]), "latitude": float(value["y"])})


class KakaoProvider(Provider):
    name = "kakao"

    def __init__(
        self,
        mode: ProviderMode = "disconnected",
        *,
        rest_key: str | None = None,
        mobility_key: str | None = None,
        transport: httpx.BaseTransport | None = None,
        timeout_s: float = 10.0,
    ) -> None:
        super().__init__(mode, transport=transport, timeout_s=timeout_s)
        self._rest_key = rest_key
        self._mobility_key = mobility_key or rest_key

    def _local(self, query: str, *, page: int, size: int, geocode: bool) -> dict:
        query = require_text(query)
        if (
            type(page) is not int
            or not 1 <= page <= 45
            or type(size) is not int
            or not 1 <= size <= (30 if geocode else 15)
        ):
            raise ValueError("invalid pagination")
        key = self.credential(self._rest_key)
        if self.mode == "mock" and self.transport is None:
            matching = [
                dict(place)
                for place in MOCK_PLACES
                if query in place["name"] or query in place["address"]
            ]
            offset = (page - 1) * size
            return {
                **self.metadata(),
                "places": matching[offset : offset + size],
                "total_count": len(matching),
                "pageable_count": len(matching),
                "is_end": offset + size >= len(matching),
                "page": page,
                "notice": "직접 만든 예시 장소입니다. 실제 검색 결과가 아닙니다.",
            }
        endpoint = "search/address" if geocode else "search/keyword"
        data = self.get_json(
            f"{LOCAL}/{endpoint}.json",
            params={"query": query, "page": page, "size": size},
            headers={"Authorization": f"KakaoAK {key}"} if key else None,
        )
        try:
            meta = data["meta"]
            total = nonnegative_int(meta["total_count"])
            pageable = nonnegative_int(meta["pageable_count"])
            if type(meta["is_end"]) is not bool or not isinstance(data["documents"], list):
                raise ValueError("invalid local response")
            places = []
            for item in data["documents"]:
                address = require_text(item["address_name"], maximum=1000, empty=True)
                point = provider_point(item)
                places.append(
                    {
                        "id": (
                            f"address:{point['longitude']},{point['latitude']}"
                            if geocode
                            else require_text(item["id"])
                        ),
                        "name": address
                        if geocode
                        else require_text(item["place_name"], maximum=1000),
                        "address": address,
                        **point,
                    }
                )
            return {
                **self.metadata(),
                "places": places,
                "total_count": total,
                "pageable_count": pageable,
                "is_end": meta["is_end"],
                "page": page,
            }
        except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
            raise self.malformed() from None

    def search(self, query: str, *, page: int = 1, size: int = 15) -> dict:
        return self._local(query, page=page, size=size, geocode=False)

    def geocode(self, address: str, *, page: int = 1, size: int = 10) -> dict:
        return self._local(address, page=page, size=size, geocode=True)

    def route(self, origin: dict, destination: dict, *, priority: str = "RECOMMEND") -> dict:
        origin, destination = coordinate(origin), coordinate(destination)
        if priority not in {"RECOMMEND", "TIME", "DISTANCE"}:
            raise ValueError("invalid route priority")
        key = self.credential(self._mobility_key)
        if self.mode == "mock" and self.transport is None:
            return self._mock_route(origin, destination, priority)
        data = self.get_json(
            DIRECTIONS,
            params={
                "origin": f"{origin['longitude']},{origin['latitude']}",
                "destination": f"{destination['longitude']},{destination['latitude']}",
                "priority": priority,
                "summary": "false",
                "alternatives": "false",
            },
            headers={"Authorization": f"KakaoAK {key}"} if key else None,
        )
        try:
            routes = data["routes"]
            if not isinstance(routes, list) or not routes:
                raise ValueError("missing routes")
            rejected = []
            for route in routes:
                code = nonnegative_int(route["result_code"])
                if code != 0:
                    rejected.append(code)
                    continue
                summary = route["summary"]
                distance = nonnegative_int(summary["distance"])
                duration = nonnegative_int(summary["duration"])
                raw_sections = route["sections"]
                if not isinstance(raw_sections, list) or len(raw_sections) != 1:
                    raise ValueError("unexpected section count")
                sections, geometry = [], []
                for section in raw_sections:
                    sections.append(
                        {
                            "distance_m": nonnegative_int(section["distance"]),
                            "duration_s": nonnegative_int(section["duration"]),
                        }
                    )
                    roads = section.get("roads", [])
                    if not isinstance(roads, list):
                        raise ValueError("invalid roads")
                    for road in roads:
                        vertices = road["vertexes"]
                        if not isinstance(vertices, list) or len(vertices) % 2:
                            raise ValueError("unpaired vertices")
                        for i in range(0, len(vertices), 2):
                            geometry.append(
                                provider_point({"x": vertices[i], "y": vertices[i + 1]})
                            )
                if summary["priority"] not in {"RECOMMEND", "TIME", "DISTANCE"}:
                    raise ValueError("invalid priority")
                return {
                    **self.metadata(),
                    "distance_m": distance,
                    "duration_s": duration,
                    "priority": summary["priority"],
                    "origin": provider_point(summary["origin"]),
                    "destination": provider_point(summary["destination"]),
                    "sections": sections,
                    "geometry": geometry,
                    "computed_at": self.now(),
                    "rejected_result_codes": rejected,
                }
            raise ProviderError(
                "route_unavailable", "해당 구간의 자동차 경로를 찾을 수 없습니다.", http_status=422
            )
        except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
            raise self.malformed() from None

    def _mock_route(self, origin: dict, destination: dict, priority: str) -> dict:
        station, city_hall, gangnam = [coordinate(place) for place in MOCK_PLACES]
        fixture = None
        for points, distance, duration, middle in (
            ([station, city_hall], 2400, 480, {"longitude": 126.9752, "latitude": 37.5607}),
            ([station, gangnam], 12500, 1800, {"longitude": 127.0050, "latitude": 37.5250}),
        ):
            if [origin, destination] in (points, list(reversed(points))):
                fixture = points, distance, duration, middle
                break
        if fixture is None:
            raise ProviderError(
                "mock_route_unavailable",
                "예시 길찾기는 서울역↔서울시청 또는 서울역↔강남역만 지원합니다.",
                http_status=422,
            )
        points, distance, duration, middle = fixture
        geometry = [points[0], middle, points[1]]
        if origin == points[1]:
            geometry.reverse()
        return {
            **self.metadata(),
            "distance_m": distance,
            "duration_s": duration,
            "priority": priority,
            "origin": origin,
            "destination": destination,
            "geometry": geometry,
            "sections": [{"distance_m": distance, "duration_s": duration}],
            "computed_at": self.now(),
            "rejected_result_codes": [],
            "notice": "직접 만든 예시 경로입니다. 실제 도로·교통·도착 예상 시간이 아닙니다.",
        }
