package com.drivemate.api.providers;

import static com.drivemate.api.providers.ProviderSupport.*;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Service;

@Service
public class KakaoProvider {
    private final ProviderSettings settings;
    private final ProviderHttp http;
    private volatile String placesVerifiedAt;
    private volatile String routesVerifiedAt;
    static final List<Map<String, Object>> PLACES = List.of(
        map("id", "mock-seoul-station", "name", "서울역", "address", "서울 중구 한강대로 405", "longitude", 126.9726, "latitude", 37.5547),
        map("id", "mock-seoul-city-hall", "name", "서울시청", "address", "서울 중구 세종대로 110", "longitude", 126.9784, "latitude", 37.5666),
        map("id", "mock-gangnam-station", "name", "강남역", "address", "서울 강남구 강남대로 396", "longitude", 127.0276, "latitude", 37.4979));
    public KakaoProvider(ProviderSettings settings, ProviderHttp http) { this.settings = settings; this.http = http; }
    private Map<String, Object> meta() { return metadata("kakao", settings.mode(), http.isTestTransport()); }
    private boolean configured(String key) {
        if (!settings.mode().equals("live")) return false;
        try { secret(key, 16384); return true; }
        catch (IllegalArgumentException error) { return false; }
    }
    public Map<String, Object> status() {
        boolean places = configured(settings.kakaoRestKey()), routes = configured(settings.kakaoMobilityKey());
        boolean verified = places && placesVerifiedAt != null || routes && routesVerifiedAt != null;
        String reason = !settings.mode().equals("live") ? settings.mode() : !places ? "not_configured" : verified ? "verified" : "ready";
        return map("mode", settings.mode(), "source", settings.mode().equals("mock") ? "mock" : "live", "configured", places, "connected", false, "live_verified", verified,
            "auth_type", "api_key", "requires_user_consent", false, "reason", reason,
            "capabilities", map("places", map("configured", places, "live_verified", places && placesVerifiedAt != null, "last_verified_at", placesVerifiedAt),
                "routes", map("configured", routes, "live_verified", routes && routesVerifiedAt != null, "last_verified_at", routesVerifiedAt)),
            "notice", "카카오는 서버 API 키로 검색·길찾기를 호출하며 개인 계정 연결은 필요하지 않습니다. 검증 시각은 현재 서버 실행 중 마지막 성공을 뜻합니다.");
    }
    public Map<String, Object> search(String query) { return local(query, 1, 15, false); }
    public Map<String, Object> local(String query, int page, int size, boolean geocode) {
        try {
            Map<String, Object> result = localResponse(query, page, size, geocode);
            if (settings.mode().equals("live") && !http.isTestTransport()) placesVerifiedAt = now();
            return result;
        } catch (ProviderException error) { placesVerifiedAt = null; throw error; }
    }
    private Map<String, Object> localResponse(String query, int page, int size, boolean geocode) {
        if (query == null || query.isBlank() || query.length() > 200 || page < 1 || page > 45 || size < 1 || size > (geocode ? 30 : 15)) throw new IllegalArgumentException("Invalid place search");
        query = query.trim(); String key = credential(settings.mode(), settings.kakaoRestKey());
        if (settings.mode().equals("mock")) {
            String filter = query;
            List<Map<String, Object>> matching = PLACES.stream().filter(place -> ((String) place.get("name")).contains(filter) || ((String) place.get("address")).contains(filter)).toList();
            int offset = (page - 1) * size;
            Map<String, Object> result = meta();
            result.putAll(map("places", matching.stream().skip(offset).limit(size).toList(), "total_count", matching.size(), "pageable_count", matching.size(), "is_end", offset + size >= matching.size(), "page", page, "notice", "직접 만든 예시 장소입니다. 실제 검색 결과가 아닙니다."));
            return result;
        }
        JsonNode data = http.get("https://dapi.kakao.com/v2/local/search/" + (geocode ? "address" : "keyword") + ".json",
            Map.of("query", query, "page", String.valueOf(page), "size", String.valueOf(size)), "KakaoAK " + key);
        try {
            JsonNode meta = data.path("meta"), documents = data.get("documents");
            long total = integer(meta.get("total_count")), pageable = integer(meta.get("pageable_count"));
            if (!meta.path("is_end").isBoolean() || documents == null || !documents.isArray()) throw new IllegalArgumentException();
            List<Map<String, Object>> places = new ArrayList<>();
            for (JsonNode item : documents) {
                String address = text(item.get("address_name"), 1000, true);
                Map<String, Object> point = providerPoint(item);
                places.add(map("id", geocode ? "address:" + point.get("longitude") + "," + point.get("latitude") : text(item.get("id"), 200, false), "name", geocode ? address : text(item.get("place_name"), 1000, false), "address", address, "longitude", point.get("longitude"), "latitude", point.get("latitude")));
            }
            Map<String, Object> result = meta(); result.putAll(map("places", places, "total_count", total, "pageable_count", pageable, "is_end", meta.get("is_end").asBoolean(), "page", page)); return result;
        } catch (IllegalArgumentException | NullPointerException error) { throw malformed(); }
    }
    static Map<String, Object> coordinate(double longitude, double latitude) {
        if (!Double.isFinite(longitude) || !Double.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw new IllegalArgumentException("Invalid coordinates");
        return map("longitude", longitude, "latitude", latitude);
    }
    static Map<String, Object> providerPoint(JsonNode node) { return coordinate(number(node.get("x"), true), number(node.get("y"), true)); }
    public Map<String, Object> route(Map<String, Object> origin, Map<String, Object> destination) {
        try {
            Map<String, Object> result = routeResponse(origin, destination);
            if (settings.mode().equals("live") && !http.isTestTransport()) routesVerifiedAt = now();
            return result;
        } catch (ProviderException error) { routesVerifiedAt = null; throw error; }
    }
    private Map<String, Object> routeResponse(Map<String, Object> origin, Map<String, Object> destination) {
        String key = credential(settings.mode(), settings.kakaoMobilityKey());
        if (settings.mode().equals("mock")) return mockRoute(origin, destination);
        JsonNode data = http.get("https://apis-navi.kakaomobility.com/v1/directions", Map.of(
            "origin", origin.get("longitude") + "," + origin.get("latitude"), "destination", destination.get("longitude") + "," + destination.get("latitude"),
            "priority", "RECOMMEND", "summary", "false", "alternatives", "false"), "KakaoAK " + key);
        try {
            JsonNode routes = data.get("routes");
            if (routes == null || !routes.isArray() || routes.isEmpty()) throw new IllegalArgumentException();
            List<Long> rejected = new ArrayList<>();
            for (JsonNode route : routes) {
                long code = integer(route.get("result_code")); if (code != 0) { rejected.add(code); continue; }
                JsonNode summary = route.get("summary"), sections = route.get("sections");
                long distance = integer(summary.get("distance")), duration = integer(summary.get("duration"));
                String priority = text(summary.get("priority"), 20, false);
                if (!Set.of("RECOMMEND", "TIME", "DISTANCE").contains(priority) || sections == null || !sections.isArray() || sections.size() != 1) throw new IllegalArgumentException();
                List<Map<String, Object>> geometry = new ArrayList<>(), normalizedSections = new ArrayList<>();
                for (JsonNode section : sections) {
                    normalizedSections.add(map("distance_m", integer(section.get("distance")), "duration_s", integer(section.get("duration"))));
                    JsonNode roads = section.path("roads");
                    if (!roads.isMissingNode() && !roads.isArray()) throw new IllegalArgumentException();
                    for (JsonNode road : roads) {
                        JsonNode vertices = road.get("vertexes");
                        if (vertices == null || !vertices.isArray() || vertices.size() % 2 != 0) throw new IllegalArgumentException();
                        for (int i = 0; i < vertices.size(); i += 2) geometry.add(coordinate(number(vertices.get(i), true), number(vertices.get(i + 1), true)));
                    }
                }
                Map<String, Object> result = meta();
                result.putAll(map("distance_m", distance, "duration_s", duration, "priority", priority, "origin", providerPoint(summary.get("origin")), "destination", providerPoint(summary.get("destination")), "sections", normalizedSections, "geometry", geometry, "computed_at", now(), "rejected_result_codes", rejected)); return result;
            }
            throw new ProviderException("route_unavailable", "해당 구간의 자동차 경로를 찾을 수 없습니다.", 422);
        } catch (IllegalArgumentException | NullPointerException error) { throw malformed(); }
    }
    private Map<String, Object> mockRoute(Map<String, Object> origin, Map<String, Object> destination) {
        List<Map<String, Object>> points = PLACES.stream().map(place -> coordinate((double) place.get("longitude"), (double) place.get("latitude"))).toList();
        boolean reverse = destination.equals(points.get(0)); Map<String, Object> other = reverse ? origin : destination;
        if ((!origin.equals(points.get(0)) && !reverse) || (!other.equals(points.get(1)) && !other.equals(points.get(2)))) throw new ProviderException("mock_route_unavailable", "예시 길찾기는 서울역↔서울시청 또는 서울역↔강남역만 지원합니다.", 422);
        boolean nearby = other.equals(points.get(1)); long distance = nearby ? 2400 : 12500, duration = nearby ? 480 : 1800;
        Map<String, Object> middle = nearby ? coordinate(126.9752, 37.5607) : coordinate(127.0050, 37.5250);
        Map<String, Object> result = meta();
        result.putAll(map("distance_m", distance, "duration_s", duration, "priority", "RECOMMEND", "origin", origin, "destination", destination,
            "geometry", List.of(origin, middle, destination), "sections", List.of(map("distance_m", distance, "duration_s", duration)), "computed_at", now(), "rejected_result_codes", List.of(), "notice", "직접 만든 예시 경로입니다. 실제 도로·교통·도착 예상 시간이 아닙니다."));
        return result;
    }
}
