package com.drivemate.api.providers;

import static com.drivemate.api.providers.ProviderSupport.map;
import static org.junit.jupiter.api.Assertions.*;
import com.drivemate.api.AppSettings;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

class ProviderTests {
    private final ObjectMapper mapper = new ObjectMapper();
    private ProviderSettings settings(String mode) {
        return new ProviderSettings(new AppSettings(mode, 12, "http://localhost:8081"),
            new MockEnvironment().withProperty("DRIVEMATE_KAKAO_REST_KEY", "synthetic-provider-key"));
    }
    private ProviderHttp.Reply reply(Object value) throws Exception {
        return new ProviderHttp.Reply(200, mapper.writeValueAsBytes(value), null);
    }
    private ProviderHttp fixture(Object value) {
        return new ProviderHttp(mapper, request -> new ProviderHttp.Reply(200, mapper.writeValueAsBytes(value), null));
    }
    @Test void mockProvidersNeverOpenNetworkAndRemainExplicit() {
        ProviderHttp forbidden = new ProviderHttp(mapper, request -> { throw new AssertionError("Mock opened network"); });
        KakaoProvider kakao = new KakaoProvider(settings("mock"), forbidden);
        Map<String, Object> places = kakao.search("서울");
        assertEquals("mock", places.get("source")); assertEquals(3, ((List<?>) places.get("places")).size());
        Map<String, Object> station = KakaoProvider.coordinate(126.9726, 37.5547), hall = KakaoProvider.coordinate(126.9784, 37.5666);
        Map<String, Object> route = kakao.route(station, hall);
        assertEquals(2400L, route.get("distance_m")); assertEquals(480L, route.get("duration_s"));
        assertEquals(List.of(hall, KakaoProvider.coordinate(126.9752, 37.5607), station), kakao.route(hall, station).get("geometry"));
        assertThrows(ProviderException.class, () -> kakao.route(station, KakaoProvider.coordinate(127, 38)));
        GoogleCalendarProvider calendar = new GoogleCalendarProvider(forbidden, mapper);
        Map<String, Object> events = calendar.listEvents("mock", null, OffsetDateTime.parse("2026-10-28T00:00:00Z"), OffsetDateTime.parse("2026-11-01T00:00:00Z"));
        assertEquals(3, ((List<?>) events.get("events")).size());
        Map<String, Object> hyundai = new HyundaiProvider(settings("mock"), mapper).vehicleStatus("EV");
        assertEquals("mock", hyundai.get("source")); assertNull(hyundai.get("observed_at"));
        assertEquals("absolute_provider_reading_do_not_add_trip_distance", hyundai.get("odometer_policy"));
    }
    @Test void disconnectedAndUnconfiguredDoNotInventLiveData() {
        ProviderHttp forbidden = new ProviderHttp(mapper, request -> { throw new AssertionError("Network must not open"); });
        assertEquals("provider_disconnected", assertThrows(ProviderException.class,
            () -> new KakaoProvider(settings("disconnected"), forbidden).search("서울")).code());
        ProviderSettings live = new ProviderSettings(new AppSettings("live", 12, "http://localhost"), new MockEnvironment());
        assertEquals("provider_not_configured", assertThrows(ProviderException.class, () -> new KakaoProvider(live, forbidden).search("서울")).code());
        assertEquals("provider_not_configured", assertThrows(ProviderException.class, () -> new HyundaiProvider(live, mapper).vehicleStatus("EV")).code());
    }
    @Test void integrationStatusSeparatesServerKeyFromAccountConsentAndVerification() {
        ProviderHttp forbidden = new ProviderHttp(mapper, request -> { throw new AssertionError("Status opened network"); });
        Map<String, Object> kakao = new KakaoProvider(settings("live"), forbidden).status();
        assertEquals("api_key", kakao.get("auth_type")); assertEquals(true, kakao.get("configured"));
        assertEquals(false, kakao.get("requires_user_consent")); assertEquals(false, kakao.get("connected"));
        assertEquals(false, kakao.get("live_verified")); assertEquals("ready", kakao.get("reason"));
        assertFalse(kakao.toString().contains("synthetic-provider-key"));
        assertEquals("disconnected", new KakaoProvider(settings("disconnected"), forbidden).status().get("reason"));
        Map<String, Object> hyundai = new HyundaiProvider(settings("live"), mapper).status();
        assertEquals(false, hyundai.get("configured")); assertEquals(false, hyundai.get("live_verified"));
        assertEquals(true, hyundai.get("requires_user_consent")); assertEquals("implementation_pending", hyundai.get("reason"));
    }
    @Test void kakaoVerificationRequiresValidatedProductionResponseAndClearsAfterFailure() {
        Object response = map("meta", map("total_count", 0, "pageable_count", 0, "is_end", true), "documents", List.of());
        KakaoProvider fixtureProvider = new KakaoProvider(settings("live"), fixture(response));
        fixtureProvider.search("서울");
        assertEquals(false, fixtureProvider.status().get("live_verified"));
        AtomicInteger calls = new AtomicInteger();
        // Exercise production metadata handling with synthetic bytes, without an external API call.
        ProviderHttp productionShape = new ProviderHttp(mapper, request -> calls.incrementAndGet() == 1
            ? new ProviderHttp.Reply(200, mapper.writeValueAsBytes(response), null)
            : new ProviderHttp.Reply(403, new byte[0], null)) {
            @Override public boolean isTestTransport() { return false; }
        };
        KakaoProvider provider = new KakaoProvider(settings("live"), productionShape);
        provider.search("서울");
        assertEquals(true, provider.status().get("live_verified"));
        Map<?, ?> capabilities = (Map<?, ?>) provider.status().get("capabilities");
        assertNotNull(((Map<?, ?>) capabilities.get("places")).get("last_verified_at"));
        assertEquals(false, ((Map<?, ?>) capabilities.get("routes")).get("live_verified"));
        assertThrows(ProviderException.class, () -> provider.search("서울"));
        assertEquals(false, provider.status().get("live_verified"));
    }
    @Test void kakaoConfiguredRejectsMalformedCredentialsWithoutNetwork() {
        ProviderSettings invalid = new ProviderSettings(new AppSettings("live", 12, "http://localhost"),
            new MockEnvironment().withProperty("DRIVEMATE_KAKAO_REST_KEY", "invalid key"));
        ProviderHttp forbidden = new ProviderHttp(mapper, request -> { throw new AssertionError("Status opened network"); });
        assertEquals(false, new KakaoProvider(invalid, forbidden).status().get("configured"));
        assertEquals("not_configured", new KakaoProvider(invalid, forbidden).status().get("reason"));
    }
    @Test void fixedKakaoEndpointAndMetricValidation() {
        Object response = map("routes", List.of(map("result_code", 0, "summary", map("distance", 1234, "duration", 567, "priority", "RECOMMEND", "origin", map("x", 126.9726, "y", 37.5547), "destination", map("x", 126.9784, "y", 37.5666)),
            "sections", List.of(map("distance", 1234, "duration", 560, "roads", List.of(map("vertexes", List.of(126.9726, 37.5547, 126.9784, 37.5666))))))));
        ProviderHttp http = new ProviderHttp(mapper, request -> {
            assertEquals("apis-navi.kakaomobility.com", request.uri().getHost());
            assertEquals("KakaoAK synthetic-provider-key", request.headers().firstValue("Authorization").orElseThrow());
            assertFalse(request.uri().toString().contains("synthetic-provider-key"));
            return new ProviderHttp.Reply(200, mapper.writeValueAsBytes(response), null);
        });
        Map<String, Object> result = new KakaoProvider(settings("live"), http).route(KakaoProvider.coordinate(126.9726, 37.5547), KakaoProvider.coordinate(126.9784, 37.5666));
        assertEquals(567L, result.get("duration_s")); assertEquals("mock", result.get("source"));
        ProviderHttp malformed = fixture(map("routes", List.of(map("result_code", true))));
        assertEquals("provider_malformed_response", assertThrows(ProviderException.class,
            () -> new KakaoProvider(settings("live"), malformed).route(KakaoProvider.coordinate(126, 37), KakaoProvider.coordinate(127, 38))).code());
    }
    @Test void providerFailuresAreBoundedSafeAndNeverFollowRedirects() {
        ProviderHttp timeout = new ProviderHttp(mapper, request -> { throw new HttpTimeoutException("private-access-token"); });
        ProviderException error = assertThrows(ProviderException.class, () -> timeout.get("https://dapi.kakao.com/v2/local/search/keyword.json", Map.of("query", "a"), "test"));
        assertEquals("provider_timeout", error.code()); assertFalse(error.getMessage().contains("private"));
        ProviderHttp redirect = new ProviderHttp(mapper, request -> new ProviderHttp.Reply(302, new byte[0], null));
        assertEquals("provider_http_error", assertThrows(ProviderException.class, () -> redirect.get("https://dapi.kakao.com/v2/local", Map.of(), null)).code());
        assertThrows(IllegalArgumentException.class, () -> redirect.get("https://example.org/steal", Map.of(), "secret"));
        ProviderHttp quota = new ProviderHttp(mapper, request -> new ProviderHttp.Reply(429, new byte[0], "9999"));
        assertEquals(120d, assertThrows(ProviderException.class, () -> quota.get("https://dapi.kakao.com/v2/local", Map.of(), null)).retryAfter());
    }
    @Test void calendarPagesDeduplicateAndHonorExclusiveAllDayEnd() {
        Object event = map("id", "event", "summary", "all day", "start", map("date", "2026-10-29"), "end", map("date", "2026-10-30"));
        AtomicInteger pages = new AtomicInteger();
        ProviderHttp http = new ProviderHttp(mapper, request -> {
            int page = pages.incrementAndGet();
            Object payload = page == 1 ? map("timeZone", "Asia/Seoul", "items", List.of(event), "nextPageToken", "page2") : map("timeZone", "Asia/Seoul", "items", List.of(event));
            return new ProviderHttp.Reply(200, mapper.writeValueAsBytes(payload), null);
        });
        Map<String, Object> result = new GoogleCalendarProvider(http, mapper).listEvents("live", "synthetic", OffsetDateTime.parse("2026-10-29T00:00:00+09:00"), OffsetDateTime.parse("2026-10-30T00:00:00+09:00"));
        assertEquals(2, result.get("pages_fetched")); assertEquals(1, ((List<?>) result.get("events")).size());
        Map<String, Object> normalized = GoogleCalendarProvider.normalizeEvent(mapper.valueToTree(event), "Asia/Seoul");
        assertFalse(GoogleCalendarProvider.overlaps(normalized, OffsetDateTime.parse("2026-10-30T00:00:00+09:00").toInstant(), OffsetDateTime.parse("2026-10-31T00:00:00+09:00").toInstant()));
    }
    @Test void calendarRejectsCyclesAndAmbiguousLocalTimes() {
        ProviderHttp repeated = fixture(map("timeZone", "Asia/Seoul", "items", List.of(), "nextPageToken", "same"));
        assertThrows(ProviderException.class, () -> new GoogleCalendarProvider(repeated, mapper).listEvents("live", "synthetic", OffsetDateTime.parse("2026-10-28T00:00:00Z"), OffsetDateTime.parse("2026-11-01T00:00:00Z")));
        assertThrows(IllegalArgumentException.class, () -> GoogleCalendarProvider.instant(mapper.valueToTree("2026-11-01T01:30:00"), mapper.valueToTree("America/New_York")));
        assertThrows(IllegalArgumentException.class, () -> GoogleCalendarProvider.instant(mapper.valueToTree("2026-10-29T10:00:00"), null));
    }
    @Test void hyundaiPreservesRawUnitsAndRejectsInvalidReadings() {
        var result = HyundaiProvider.normalizeOdometer(mapper.valueToTree(map("msgId", "sample", "odometers", List.of(map("date", "20261028", "timestamp", "20261028090000", "value", 10, "unit", 3)))), Instant.now());
        assertEquals(16.09344, result.get("odometer_km")); assertNull(result.get("provider_timezone"));
        assertThrows(ProviderException.class, () -> HyundaiProvider.normalizeOdometer(mapper.valueToTree(map("msgId", "sample", "odometers", List.of(map("date", "20260230", "timestamp", "20260230090000", "value", -1, "unit", 1)))), Instant.now()));
    }
    @Test void calendarFollowsOmittedEmptyPagesAndRejectsMalformedCollections() {
        AtomicInteger pages = new AtomicInteger();
        GoogleCalendarProvider calendar = new GoogleCalendarProvider(new ProviderHttp(mapper, request -> {
            int page = pages.incrementAndGet();
            if (page == 1) return new ProviderHttp.Reply(200, mapper.writeValueAsBytes(map("timeZone", "Asia/Seoul", "nextPageToken", "second")), null);
            assertTrue(request.uri().getQuery().contains("pageToken=second"));
            return new ProviderHttp.Reply(200, mapper.writeValueAsBytes(map("timeZone", "Asia/Seoul")), null);
        }), mapper);
        Map<String, Object> result = calendar.listEvents("live", "synthetic-access", OffsetDateTime.parse("2026-11-09T00:00:00Z"), OffsetDateTime.parse("2026-11-10T00:00:00Z"));
        assertEquals(List.of(), result.get("events")); assertEquals(2, result.get("pages_fetched")); assertEquals(true, result.get("complete"));
        for (Object items : Arrays.asList(null, "invalid", Map.of())) {
            GoogleCalendarProvider broken = new GoogleCalendarProvider(fixture(map("timeZone", "Asia/Seoul", "items", items)), mapper);
            assertThrows(ProviderException.class, () -> broken.listEvents("live", "synthetic-access", OffsetDateTime.parse("2026-11-09T00:00:00Z"), OffsetDateTime.parse("2026-11-10T00:00:00Z")));
        }
    }
    @Test void googleCallbackConfigurationUsesTheActualEndpointAndSafeOrigin() {
        for (String redirect : List.of("https://app.example.test/api/v1/integrations/google/callback", "http://localhost:18086/api/v1/integrations/google/callback")) {
            assertTrue(oauthWithRedirect(redirect).configured());
        }
        for (String redirect : List.of("https://app.example.test/elsewhere", "https://app.example.test/api/v1/integrations/google/callback?next=https://evil.test", "https://app.example.test/api/v1/integrations/google/callback#fragment", "http://public.example.test/api/v1/integrations/google/callback", "https://user:pass@app.example.test/api/v1/integrations/google/callback")) {
            assertFalse(oauthWithRedirect(redirect).configured());
        }
    }
    private GoogleOAuthClient oauthWithRedirect(String redirect) {
        ProviderSettings value = new ProviderSettings(new AppSettings("live", 12, "http://localhost"), new MockEnvironment()
            .withProperty("DRIVEMATE_GOOGLE_CLIENT_ID", "synthetic-client")
            .withProperty("DRIVEMATE_GOOGLE_CLIENT_SECRET", "synthetic-secret")
            .withProperty("DRIVEMATE_GOOGLE_REDIRECT_URI", redirect));
        return new GoogleOAuthClient(value, new ProviderHttp(mapper, request -> { throw new AssertionError("Configuration must not contact Google"); }));
    }

}
