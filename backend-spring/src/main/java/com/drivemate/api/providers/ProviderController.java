package com.drivemate.api.providers;

import static com.drivemate.api.providers.ProviderSupport.*;
import com.drivemate.api.ApiException;
import com.drivemate.api.Auth;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1")
public class ProviderController {
    private final Auth auth;
    private final ProviderSettings settings;
    private final KakaoProvider kakao;
    private final GoogleCalendarProvider calendar;
    private final GoogleIntegration google;
    private final HyundaiProvider hyundai;
    public ProviderController(Auth auth, ProviderSettings settings, KakaoProvider kakao, GoogleCalendarProvider calendar, GoogleIntegration google, HyundaiProvider hyundai) {
        this.auth = auth; this.settings = settings; this.kakao = kakao; this.calendar = calendar; this.google = google; this.hyundai = hyundai;
    }
    @GetMapping("/integrations") public Map<String, Object> integrations(HttpServletRequest request) {
        String uid = (String) auth.require(request).get("id"), mode = settings.mode();
        Map<String, Object> googleStatus = map("mode", mode); googleStatus.putAll(google.status(uid));
        return map("provider_mode", mode, "providers", map(
            "kakao", kakao.status(), "google_calendar", googleStatus, "hyundai", hyundai.status()),
            "notice", mode.equals("mock") ? "예시 모드는 외부 API 연결이나 실제 계정 인증을 뜻하지 않습니다."
                : "서버 설정, 사용자 동의와 실제 조회 성공은 각각 확인합니다. Google 캘린더 연결은 DriveMate 로그인이 아닙니다.");
    }
    @PostMapping("/integrations/google/authorize") public Map<String, Object> authorize(HttpServletRequest request) {
        return google.authorize((String) auth.requireProvider(request).get("id"));
    }
    @DeleteMapping("/integrations/google") public Map<String, Object> disconnect(HttpServletRequest request) {
        return google.disconnect((String) auth.require(request).get("id"));
    }
    @GetMapping(value = "/integrations/google/callback", produces = "text/html;charset=UTF-8")
    public ResponseEntity<String> callback(@RequestParam(name = "state") String state,
            @RequestParam(name = "code", required = false) String code, @RequestParam(name = "error", required = false) String error) {
        if (state.length() > 256 || code != null && code.length() > 4096 || error != null && error.length() > 256) throw invalid();
        google.callback(state, code, error);
        return ResponseEntity.ok().header("Referrer-Policy", "no-referrer").header("Content-Security-Policy", "default-src 'none'")
            .header("Cache-Control", "no-store").body("<!doctype html><html lang=\"ko\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>DriveMate Google 연결</title><body><h1>Calendar 연결 완료</h1><p>DriveMate로 돌아가 일정을 다시 조회해 주세요. 이 창은 닫아도 됩니다.</p></body></html>");
    }
    @GetMapping("/places") public Map<String, Object> places(@RequestParam(name = "q") String query, HttpServletRequest request) {
        auth.requireProvider(request);
        if (query.isBlank() || query.length() > 160) throw new ApiException("invalid_query", "검색할 장소를 입력해 주세요.", 422);
        return kakao.search(query);
    }
    @PostMapping("/routes") public Map<String, Object> route(@RequestBody JsonNode body, HttpServletRequest request) {
        auth.requireProvider(request);
        try {
            if (!body.isObject()) throw new IllegalArgumentException();
            Set<String> allowed = Set.of("origin", "destination", "arrival_at", "walk_minutes", "buffer_minutes");
            body.fieldNames().forEachRemaining(name -> { if (!allowed.contains(name)) throw new IllegalArgumentException(); });
            Map<String, Object> origin = point(body.get("origin")), destination = point(body.get("destination"));
            OffsetDateTime arrival = timestamp(text(body.get("arrival_at"), 100, false));
            double walk = body.has("walk_minutes") ? number(body.get("walk_minutes"), false) : 10;
            double buffer = body.has("buffer_minutes") ? number(body.get("buffer_minutes"), false) : 10;
            if (walk < 0 || walk > 180 || buffer < 0 || buffer > 180) throw new IllegalArgumentException();
            Map<String, Object> result = kakao.route(origin, destination);
            long drivingSeconds = ((Number) result.get("duration_s")).longValue();
            OffsetDateTime departure = arrival.minusSeconds(drivingSeconds).minusNanos(Math.round(60 * (walk + buffer) * 1_000_000_000));
            if (departure.getYear() < 1 || departure.getYear() > 9999) throw new IllegalArgumentException();
            Instant computed = Instant.now();
            result.putAll(map("arrival_at", arrival.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME), "departure_at", departure.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
                "computed_at", computed.toString(), "expires_at", computed.plusSeconds(300).toString(), "walk_minutes", walk, "buffer_minutes", buffer));
            return result;
        } catch (IllegalArgumentException | DateTimeException | ArithmeticException | NullPointerException error) { throw invalid(); }
    }
    private static Map<String, Object> point(JsonNode value) {
        if (value == null || !value.isObject() || value.size() != 2 || !value.has("longitude") || !value.has("latitude")) throw new IllegalArgumentException();
        return KakaoProvider.coordinate(number(value.get("longitude"), false), number(value.get("latitude"), false));
    }
    @GetMapping("/calendar/events") public Map<String, Object> events(@RequestParam(name = "time_min", required = false) String minimum,
            @RequestParam(name = "time_max", required = false) String maximum, HttpServletRequest request) {
        String uid = (String) auth.requireProvider(request).get("id");
        try {
            OffsetDateTime start = minimum == null ? OffsetDateTime.now(ZoneOffset.UTC) : timestamp(minimum);
            OffsetDateTime end = maximum == null ? start.plusDays(30) : timestamp(maximum);
            Duration span = Duration.between(start.toInstant(), end.toInstant());
            if (span.isNegative() || span.isZero() || span.compareTo(Duration.ofDays(90)) > 0 || end.getYear() > 9999 || start.getYear() < 1) throw new IllegalArgumentException();
            return settings.mode().equals("live") ? google.listEvents(uid, start, end) : calendar.listEvents(settings.mode(), null, start, end);
        } catch (IllegalArgumentException | DateTimeException error) { throw new ApiException("invalid_window", "일정 조회 기간은 시간대를 포함한 90일 이내여야 해요.", 422); }
    }
    @GetMapping("/vehicles/status") public Map<String, Object> vehicleStatus(@RequestParam(name = "powertrain", defaultValue = "EV") String powertrain, HttpServletRequest request) {
        auth.requireProvider(request);
        if (!Set.of("ICE", "HYB", "EV").contains(powertrain)) throw invalid();
        return hyundai.vehicleStatus(powertrain);
    }
    private static ApiException invalid() { return new ApiException("invalid_request", "입력 형식과 범위를 확인해 주세요.", 422); }
}
