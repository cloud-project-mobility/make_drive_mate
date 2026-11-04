package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:coretest;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "DRIVEMATE_PROVIDER_MODE=mock"
})
@AutoConfigureMockMvc
class CoreApiTest {
    @Autowired MockMvc http;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired Store store;
    @Autowired SnapshotValidator validator;

    private String register() throws Exception {
        String email = UUID.randomUUID() + "@example.test";
        String payload = json.writeValueAsString(Map.of("email", email, "password", "test-password-2026"));
        var result = http.perform(post("/api/v1/auth/register").contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().isCreated()).andReturn();
        return json.readTree(result.getResponse().getContentAsString()).get("access_token").asText();
    }

    private ObjectNode state() throws Exception {
        return (ObjectNode) json.readTree("""
                {"version":1,"vehicles":[{"id":"vehicle-1","name":"내 차량","model":"아반떼","powertrain":"ICE",
                 "odometerKm":10000,"createdAt":"2026-11-04T00:00:00Z"}],"selectedVehicleId":"vehicle-1",
                 "trips":[],"plans":[],"maintenance":[],"activeTrip":null,
                 "settings":{"walkMinutes":10,"bufferMinutes":10},"onboarded":true,"demoMode":false}
                """);
    }

    private String upload(long revision, JsonNode state) throws Exception {
        return json.writeValueAsString(Map.of("expected_revision", revision, "state", state));
    }

    @Test void authenticationSessionsAndDeletionAreReal() throws Exception {
        String token = register();
        http.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk()).andExpect(jsonPath("$.email").isString());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM sessions WHERE token_hash=?", Long.class, token)).isZero();
        http.perform(post("/api/v1/auth/logout").header("Authorization", "Bearer " + token)).andExpect(status().isOk());
        http.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + token)).andExpect(status().isUnauthorized());
        String second = register();
        http.perform(delete("/api/v1/account").header("Authorization", "Bearer " + second)).andExpect(status().isOk());
        http.perform(get("/api/v1/state").header("Authorization", "Bearer " + second)).andExpect(status().isUnauthorized());
    }

    @Test void snapshotsAreAccountScopedIdempotentAndOptimistic() throws Exception {
        String first = register();
        String second = register();
        ObjectNode state = state();
        http.perform(put("/api/v1/state").header("Authorization", "Bearer " + first)
                .contentType(MediaType.APPLICATION_JSON).content(upload(0, state)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.revision").value(1));
        http.perform(put("/api/v1/state").header("Authorization", "Bearer " + first)
                .contentType(MediaType.APPLICATION_JSON).content(upload(0, state)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.revision").value(1));
        http.perform(get("/api/v1/state").header("Authorization", "Bearer " + second))
                .andExpect(status().isOk()).andExpect(jsonPath("$.revision").value(0)).andExpect(jsonPath("$.state").isEmpty());
        ((ObjectNode) state.get("settings")).put("walkMinutes", 11);
        http.perform(put("/api/v1/state").header("Authorization", "Bearer " + first)
                .contentType(MediaType.APPLICATION_JSON).content(upload(0, state)))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.error.code").value("revision_conflict"));
        http.perform(put("/api/v1/state").header("Authorization", "Bearer " + first)
                .contentType(MediaType.APPLICATION_JSON).content(upload(1, state)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.revision").value(2));
    }

    @Test void invalidSnapshotsCannotOverwriteTheAccount() throws Exception {
        String token = register();
        ObjectNode invalid = state();
        invalid.put("activeTrip", "recording");
        http.perform(put("/api/v1/state").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON).content(upload(0, invalid))).andExpect(status().isUnprocessableEntity());
        invalid = state();
        invalid.put("selectedVehicleId", "someone-elses-vehicle");
        http.perform(put("/api/v1/state").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON).content(upload(0, invalid))).andExpect(status().isUnprocessableEntity());
        invalid = state();
        ((ObjectNode) invalid.get("vehicles").get(0)).put("odometerKm", "10000");
        http.perform(put("/api/v1/state").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON).content(upload(0, invalid))).andExpect(status().isUnprocessableEntity());
        http.perform(get("/api/v1/state").header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$.revision").value(0));
    }

    @Test void validatesTripMaintenanceAndMockProvenance() throws Exception {
        ObjectNode valid = state();
        valid.withArray("trips").add(json.readTree("""
                {"id":"trip","vehicleId":"vehicle-1","startedAt":"2026-11-04T01:00:00Z",
                 "endedAt":"2026-11-04T01:10:00Z","distanceKm":3,"durationSeconds":600,"source":"manual"}
                """));
        valid.withArray("maintenance").add(json.readTree("""
                {"id":"maintenance","vehicleId":"vehicle-1","itemId":"engine-oil","odometerKm":9000,
                 "performedAt":"2026-11-04T01:00:00Z","note":"메모\\n두 줄"}
                """));
        validator.validate(valid);
        ((ObjectNode) valid.get("trips").get(0)).put("durationSeconds", 603);
        org.junit.jupiter.api.Assertions.assertThrows(ApiException.class, () -> validator.validate(valid));
        ((ObjectNode) valid.get("trips").get(0)).put("durationSeconds", 600);
        ((ObjectNode) valid.get("maintenance").get(0)).put("odometerKm", 11000);
        org.junit.jupiter.api.Assertions.assertThrows(ApiException.class, () -> validator.validate(valid));
    }

    @Test void failuresNeverEchoPasswordsAndRateLimitsPersist() throws Exception {
        http.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":\"invalid\",\"password\":\"secret-example\"}"))
                .andExpect(status().isUnprocessableEntity()).andExpect(content().string(org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsString("secret-example"))));
        String bucket = "test:" + UUID.randomUUID();
        store.rateLimit(bucket, 1, 60);
        org.junit.jupiter.api.Assertions.assertThrows(ApiException.class, () -> store.rateLimit(bucket, 1, 60));
        jdbc.update("UPDATE rate_limits SET reset_at=0 WHERE bucket=?", bucket);
        store.rateLimit(bucket, 1, 60);
    }

    @Test void oversizedBodiesAndUnknownFieldsAreRejected() throws Exception {
        http.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON).content("x".repeat(RequestLimits.LIMIT + 1)))
                .andExpect(status().isPayloadTooLarge()).andExpect(jsonPath("$.error.code").value("body_too_large"));
        http.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":\"x@example.test\",\"password\":\"test-password\",\"admin\":true}"))
                .andExpect(status().isUnprocessableEntity());
    }

    @Test void healthChecksDatabaseAndCorsIsExplicit() throws Exception {
        http.perform(get("/api/v1/health")).andExpect(status().isOk()).andExpect(jsonPath("$.backend").value("spring"))
                .andExpect(header().string("Cache-Control", "no-store"));
        http.perform(options("/api/v1/state").header("Origin", "https://untrusted.example")
                .header("Access-Control-Request-Method", "PUT")).andExpect(status().isForbidden());
        http.perform(options("/api/v1/state").header("Origin", "http://localhost:8081")
                .header("Access-Control-Request-Method", "PUT")).andExpect(status().isOk())
                .andExpect(header().string("Access-Control-Allow-Origin", "http://localhost:8081"));
    }

    @Test void loginNormalizesEmailAndExpiredSessionsFail() throws Exception {
        String email = UUID.randomUUID() + "@EXAMPLE.TEST";
        String payload = json.writeValueAsString(Map.of("email", email, "password", "test-password-2026"));
        http.perform(post("/api/v1/auth/register").contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().isCreated()).andExpect(jsonPath("$.user.email").value(email.toLowerCase(java.util.Locale.ROOT)));
        http.perform(post("/api/v1/auth/register").contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().isConflict());
        var result = http.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().isOk()).andReturn();
        String token = json.readTree(result.getResponse().getContentAsString()).get("access_token").asText();
        jdbc.update("UPDATE sessions SET expires_at=0 WHERE token_hash=?", Store.digest(token));
        http.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + token)).andExpect(status().isUnauthorized());
        http.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("email", email, "password", "wrong-password-2026"))))
                .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.error.code").value("invalid_credentials"));
    }

    @Test void concurrentDifferentSnapshotsCannotBothOverwriteRevisionZero() throws Exception {
        String token = register();
        String userId = (String) store.authenticate(token).get("id");
        ObjectNode first = state();
        ObjectNode second = state();
        ((ObjectNode) second.get("settings")).put("walkMinutes", 15);
        var ready = new java.util.concurrent.CountDownLatch(2);
        var start = new java.util.concurrent.CountDownLatch(1);
        var executor = java.util.concurrent.Executors.newFixedThreadPool(2);
        try {
            var tasks = java.util.List.of(first, second).stream().map(snapshot -> executor.submit(() -> {
                ready.countDown();
                start.await();
                try { store.saveState(userId, 0, snapshot); return "saved"; }
                catch (ApiException exception) { return exception.code(); }
            })).toList();
            assertThat(ready.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            start.countDown();
            assertThat(java.util.List.of(tasks.get(0).get(10, java.util.concurrent.TimeUnit.SECONDS),
                    tasks.get(1).get(10, java.util.concurrent.TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder("saved", "revision_conflict");
            assertThat(((Number) store.state(userId).get("revision")).longValue()).isEqualTo(1);
        } finally {
            start.countDown();
            executor.shutdownNow();
        }
    }

    @Test void snapshotOptionalNullsUnknownKeysAndUtf16OverflowFail() throws Exception {
        ObjectNode invalid = state();
        ((ObjectNode) invalid.get("vehicles").get(0)).put("name", "🚗".repeat(31));
        org.junit.jupiter.api.Assertions.assertThrows(ApiException.class, () -> validator.validate(invalid));
        ((ObjectNode) invalid.get("vehicles").get(0)).put("name", "내 차량");
        invalid.put("extra", "ignored?");
        org.junit.jupiter.api.Assertions.assertThrows(ApiException.class, () -> validator.validate(invalid));
        invalid.remove("extra");
        invalid.withArray("maintenance").add(json.readTree("""
                {"id":"maintenance","vehicleId":"vehicle-1","itemId":"engine-oil","odometerKm":9000,
                 "performedAt":"2026-11-04T01:00:00Z","note":null}
                """));
        org.junit.jupiter.api.Assertions.assertThrows(ApiException.class, () -> validator.validate(invalid));
    }

    @Test void valuationAndAnalyticsRequireAnActualLogin() throws Exception {
        http.perform(get("/api/v1/analytics/latest")).andExpect(status().isUnauthorized());
        http.perform(post("/api/v1/knowledge/query").contentType(MediaType.APPLICATION_JSON).content("{\"question\":\"문서 근거\"}"))
                .andExpect(status().isUnauthorized());
        http.perform(post("/api/v1/valuation/simulations").contentType(MediaType.APPLICATION_JSON)
                .content("{\"vehicle\":{\"model\":\"쏘나타\",\"age_years\":7,\"odometer_km\":151158}}"))
                .andExpect(status().isUnauthorized());
        String token = register();
        http.perform(post("/api/v1/knowledge/query").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON).content("{\"question\":\"문서 근거\"}"))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.error.code").value("knowledge_forbidden"));
        http.perform(get("/api/v1/analytics/latest").header("Authorization", "Bearer " + token))
                .andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.error.code").value("analytics_unavailable"));
    }
}
