package com.drivemate.api.providers;

import static com.drivemate.api.providers.ProviderSupport.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/** Real controllers, authentication, SQL and OAuth logic; only Google's transport is synthetic. */
@SpringBootTest(properties = {
    "spring.datasource.url=jdbc:h2:mem:calendarapi;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
    "DRIVEMATE_PROVIDER_MODE=live", "DRIVEMATE_GOOGLE_CLIENT_ID=synthetic-client",
    "DRIVEMATE_GOOGLE_CLIENT_SECRET=synthetic-secret",
    "DRIVEMATE_GOOGLE_REDIRECT_URI=http://localhost:18086/api/v1/integrations/google/callback",
    "DRIVEMATE_TOKEN_ENCRYPTION_KEY=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="
})
@AutoConfigureMockMvc
@Import(GoogleCalendarApiTest.GoogleFixture.class)
class GoogleCalendarApiTest {
    @Autowired MockMvc http;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired FakeGoogle google;
    private static final AtomicInteger accounts = new AtomicInteger();

    @TestConfiguration static class GoogleFixture {
        @Bean FakeGoogle fakeGoogle(ObjectMapper json) { return new FakeGoogle(json); }
        @Bean @Primary ProviderHttp syntheticGoogle(ObjectMapper json, FakeGoogle google) { return new ProviderHttp(json, google::send); }
    }
    static class FakeGoogle {
        final ObjectMapper json;
        int exchanges, refreshes, eventCalls, revocations;
        boolean shortToken, first401, always401, forbidden, invalidGrant, failRevoke;
        FakeGoogle(ObjectMapper json) { this.json = json; }
        void reset() { exchanges = refreshes = eventCalls = revocations = 0; shortToken = first401 = always401 = forbidden = invalidGrant = failRevoke = false; }
        ProviderHttp.Reply reply(int status, Object data) throws java.io.IOException { return new ProviderHttp.Reply(status, json.writeValueAsBytes(data), null); }
        ProviderHttp.Reply send(HttpRequest request) throws java.io.IOException {
            assertThat(request.uri().getScheme()).isEqualTo("https");
            assertThat(request.uri().toString()).doesNotContain("synthetic-secret", "private-access", "private-refresh");
            if (request.uri().getPath().equals("/token")) {
                assertThat(request.method()).isEqualTo("POST");
                if (++exchanges > 1) {
                    refreshes++;
                    if (invalidGrant) return reply(400, map("error", "invalid_grant", "error_description", "PRIVATE provider detail"));
                }
                Map<String, Object> tokens = map("access_token", "private-access-" + exchanges, "token_type", "Bearer", "scope", GoogleOAuthClient.SCOPE,
                    "expires_in", shortToken && exchanges == 1 ? 30 : 3600);
                if (exchanges == 1) tokens.put("refresh_token", "private-refresh");
                return reply(200, tokens);
            }
            if (request.uri().getPath().equals("/revoke")) {
                revocations++;
                return failRevoke ? reply(503, map("error", "private-revoke-failure")) : new ProviderHttp.Reply(200, new byte[0], null);
            }
            assertThat(request.uri().getHost()).isEqualTo("www.googleapis.com");
            assertThat(request.uri().getPath()).isEqualTo("/calendar/v3/calendars/primary/events");
            assertThat(request.headers().firstValue("Authorization")).contains("Bearer private-access-" + exchanges);
            eventCalls++;
            if (always401 || first401 && eventCalls == 1) return reply(401, map("error", "private-error"));
            if (forbidden) return reply(403, map("error", "private-error"));
            String start = OffsetDateTime.now().plusDays(1).withNano(0).toString();
            String end = OffsetDateTime.parse(start).plusHours(1).toString();
            return reply(200, map("timeZone", "Asia/Seoul", "items", List.of(map("id", "timed-event", "summary", "테스트 일정", "location", "서울시청",
                "start", map("dateTime", start), "end", map("dateTime", end)))));
        }
    }
    @BeforeEach void reset() { google.reset(); jdbc.update("DELETE FROM oauth_states"); jdbc.update("DELETE FROM provider_tokens"); }
    private String register() throws Exception {
        int number = accounts.incrementAndGet();
        var result = http.perform(post("/api/v1/auth/register").with(request -> { request.setRemoteAddr("127.0.1." + number); return request; })
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(map("email", UUID.randomUUID() + "@example.test", "password", "synthetic-password-2026"))))
            .andExpect(status().isCreated()).andReturn();
        return body(result).path("access_token").asText();
    }
    private JsonNode body(MvcResult result) throws Exception { return json.readTree(result.getResponse().getContentAsString()); }
    private String authorize(String token) throws Exception {
        var result = http.perform(post("/api/v1/integrations/google/authorize").header("Authorization", "Bearer " + token))
            .andExpect(status().isOk()).andReturn();
        String url = body(result).path("authorization_url").asText();
        assertThat(url).startsWith("https://accounts.google.com/o/oauth2/v2/auth?").contains("code_challenge_method=S256", "access_type=offline").doesNotContain("synthetic-secret");
        return Arrays.stream(URI.create(url).getRawQuery().split("&")).filter(v -> v.startsWith("state="))
            .map(v -> URLDecoder.decode(v.substring(6), StandardCharsets.UTF_8)).findFirst().orElseThrow();
    }
    private void connect(String token) throws Exception {
        http.perform(get("/api/v1/integrations/google/callback").param("state", authorize(token)).param("code", "private-code"))
            .andExpect(status().isOk()).andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_HTML))
            .andExpect(header().string("Cache-Control", "no-store")).andExpect(header().string("Referrer-Policy", "no-referrer"))
            .andExpect(content().string(org.hamcrest.Matchers.containsString("Google 캘린더 연결 완료")))
            .andExpect(content().string(org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsString("private-code"))));
    }
    @Test void completeAccountScopedHttpFlowEncryptsRefreshesReadsAndDisconnects() throws Exception {
        String first = register(), second = register(); google.shortToken = true;
        http.perform(post("/api/v1/integrations/google/authorize")).andExpect(status().isUnauthorized());
        connect(first);
        assertThat(jdbc.queryForObject("SELECT encrypted FROM provider_tokens", String.class)).startsWith("v1:").doesNotContain("private-access", "private-refresh");
        http.perform(get("/api/v1/calendar/events").header("Authorization", "Bearer " + first))
            .andExpect(status().isOk()).andExpect(jsonPath("$.events[0].title").value("테스트 일정"))
            .andExpect(jsonPath("$.events[0].location").value("서울시청")).andExpect(jsonPath("$.source").value("mock"));
        assertThat(google.refreshes).isEqualTo(1);
        http.perform(get("/api/v1/calendar/events").header("Authorization", "Bearer " + second))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.error.code").value("google_not_connected"));
        http.perform(delete("/api/v1/integrations/google").header("Authorization", "Bearer " + first))
            .andExpect(status().isOk()).andExpect(jsonPath("$.connected").value(false)).andExpect(jsonPath("$.provider_revoked").value(true));
        assertThat(google.revocations).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM provider_tokens", Integer.class)).isZero();
        http.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + first)).andExpect(status().isOk());
    }
    @Test void deniedMissingExpiredAndReplayedCallbacksHaveSafeRecoveryPages() throws Exception {
        String token = register(), state = authorize(token);
        var denied = http.perform(get("/api/v1/integrations/google/callback").param("state", state).param("error", "<script>PRIVATE</script>"))
            .andExpect(status().isBadRequest()).andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_HTML)).andReturn();
        assertThat(denied.getResponse().getContentAsString()).contains("연결이 승인되지 않았어요").doesNotContain("<script>", "PRIVATE", state);
        http.perform(get("/api/v1/integrations/google/callback")).andExpect(status().isBadRequest()).andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_HTML));
        http.perform(get("/api/v1/integrations/google/callback").param("state", state).param("code", "private-code")).andExpect(status().isBadRequest());
        String expired = authorize(token); jdbc.update("UPDATE oauth_states SET expires_at = 0");
        http.perform(get("/api/v1/integrations/google/callback").param("state", expired).param("code", "private-code")).andExpect(status().isBadRequest());
        assertThat(google.exchanges).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM provider_tokens", Integer.class)).isZero();
    }
    @Test void oversizedCallbackDoesNotReflectInputOrContactGoogle() throws Exception {
        var result = http.perform(get("/api/v1/integrations/google/callback").param("state", "x".repeat(257)).param("code", "PRIVATE"))
            .andExpect(status().isUnprocessableEntity()).andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_HTML)).andReturn();
        assertThat(result.getResponse().getContentAsString()).doesNotContain("PRIVATE", "x".repeat(257));
        assertThat(result.getResponse().getHeader("Content-Security-Policy")).contains("frame-ancestors 'none'");
        assertThat(google.exchanges).isZero();
    }
    @Test void rejectedAccessRefreshesExactlyOnceAndRepeatedRejectionRequiresConsent() throws Exception {
        String token = register(); connect(token); google.always401 = true;
        http.perform(get("/api/v1/calendar/events").header("Authorization", "Bearer " + token))
            .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.error.code").value("oauth_reauthorization_required"));
        assertThat(google.eventCalls).isEqualTo(2); assertThat(google.refreshes).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM provider_tokens", Integer.class)).isZero();
        http.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + token)).andExpect(status().isOk());
    }
    @Test void forbiddenCalendarDoesNotDeleteGrantOrLeakProviderError() throws Exception {
        String token = register(); connect(token); google.forbidden = true;
        var result = http.perform(get("/api/v1/calendar/events").header("Authorization", "Bearer " + token))
            .andExpect(status().isServiceUnavailable()).andReturn();
        assertThat(result.getResponse().getContentAsString()).doesNotContain("private-error");
        assertThat(google.refreshes).isZero(); assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM provider_tokens", Integer.class)).isEqualTo(1);
    }
    @Test void revokedRefreshTokenClearsOnlyGoogleGrant() throws Exception {
        String token = register(); google.shortToken = true; connect(token); google.invalidGrant = true;
        http.perform(get("/api/v1/calendar/events").header("Authorization", "Bearer " + token))
            .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.error.code").value("oauth_reauthorization_required"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM provider_tokens", Integer.class)).isZero();
        http.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + token)).andExpect(status().isOk());
    }
    @Test void localDisconnectSucceedsEvenWhenGoogleRevocationFails() throws Exception {
        String token = register(); connect(token); google.failRevoke = true;
        http.perform(delete("/api/v1/integrations/google").header("Authorization", "Bearer " + token))
            .andExpect(status().isOk()).andExpect(jsonPath("$.connected").value(false)).andExpect(jsonPath("$.provider_revoked").value(false));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM provider_tokens", Integer.class)).isZero();
    }
}
