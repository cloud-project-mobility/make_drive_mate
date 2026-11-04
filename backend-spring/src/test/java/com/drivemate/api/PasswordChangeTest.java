package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:passwordtest;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "DRIVEMATE_PROVIDER_MODE=mock", "DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS=owner-password@example.test"
})
@AutoConfigureMockMvc
@Import(PasswordChangeTest.ProbeConfiguration.class)
class PasswordChangeTest {
    private static final String CURRENT = "synthetic-current-password-2026";
    private static final String NEXT = "synthetic-new-password-2026";
    @Autowired MockMvc http;
    @Autowired ObjectMapper json;
    @Autowired Store store;
    @Autowired JdbcTemplate jdbc;
    @Autowired DisconnectProbe probe;

    @TestConfiguration static class ProbeConfiguration {
        @Bean DisconnectProbe passwordDisconnectProbe() { return new DisconnectProbe(); }
    }

    static class DisconnectProbe implements SessionDisconnect {
        final AtomicReference<String> account = new AtomicReference<>();
        @Override public void disconnectSession(String tokenHash) { }
        @Override public void disconnectAccountSessions(String userId) { account.set(userId); }
    }

    private Map<String, Object> account() { return store.register(UUID.randomUUID() + "@example.test", CURRENT); }
    private String token(Map<String, Object> account) { return (String) account.get("access_token"); }
    private String userId(Map<String, Object> account) { return (String) ((Map<?, ?>) account.get("user")).get("id"); }
    private String email(Map<String, Object> account) { return (String) ((Map<?, ?>) account.get("user")).get("email"); }
    private String payload(String current, String next) throws Exception {
        return json.writeValueAsString(Map.of("current_password", current, "new_password", next));
    }

    @Test void rotatesPasswordRevokesEverySessionAndPreservesOtherAccounts() throws Exception {
        var owner = account();
        var second = store.login(email(owner), CURRENT);
        var other = account();
        String oldSalt = jdbc.queryForObject("SELECT salt FROM accounts WHERE id=?", String.class, userId(owner));
        var result = http.perform(post("/api/v1/auth/password").header("Authorization", "Bearer " + token(owner))
                .contentType(MediaType.APPLICATION_JSON).content(payload(CURRENT, NEXT)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.ok").value(true))
                .andExpect(jsonPath("$.reauthentication_required").value(true)).andReturn();
        assertThat(result.getResponse().getContentAsString()).doesNotContain(CURRENT, NEXT);
        assertThat(probe.account.get()).isEqualTo(userId(owner));
        assertThat(jdbc.queryForObject("SELECT salt FROM accounts WHERE id=?", String.class, userId(owner))).isNotEqualTo(oldSalt);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM sessions WHERE user_id=?", Integer.class, userId(owner))).isZero();
        for (String revoked : List.of(token(owner), token(second))) {
            http.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + revoked)).andExpect(status().isUnauthorized());
            http.perform(post("/api/v1/auth/logout").header("Authorization", "Bearer " + revoked)).andExpect(status().isOk());
        }
        assertThat(store.authenticate(token(other)).get("id")).isEqualTo(userId(other));
        assertThatThrownBy(() -> store.login(email(owner), CURRENT)).isInstanceOf(ApiException.class);
        var fresh = store.login(email(owner), NEXT);
        assertThat(((Map<?, ?>) fresh.get("user")).get("id")).isEqualTo(userId(owner));
    }

    @Test void requiresSessionAndCorrectCurrentPasswordWithoutLeakingValues() throws Exception {
        var owner = account();
        http.perform(post("/api/v1/auth/password").contentType(MediaType.APPLICATION_JSON).content(payload(CURRENT, NEXT)))
                .andExpect(status().isUnauthorized());
        var failed = http.perform(post("/api/v1/auth/password").header("Authorization", "Bearer " + token(owner))
                .contentType(MediaType.APPLICATION_JSON).content(payload("synthetic-incorrect-password", NEXT)))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error.code").value("invalid_current_password")).andReturn();
        assertThat(failed.getResponse().getContentAsString()).doesNotContain("synthetic-incorrect-password", NEXT);
        assertThat(store.authenticate(token(owner)).get("id")).isEqualTo(userId(owner));
        assertThat(store.login(email(owner), CURRENT)).containsKey("access_token");
    }

    @Test void validatesFieldsLengthAndDifferentPassword() throws Exception {
        var owner = account();
        for (String next : List.of("short", "x".repeat(129))) {
            http.perform(post("/api/v1/auth/password").header("Authorization", "Bearer " + token(owner))
                    .contentType(MediaType.APPLICATION_JSON).content(payload(CURRENT, next))).andExpect(status().isUnprocessableEntity());
        }
        http.perform(post("/api/v1/auth/password").header("Authorization", "Bearer " + token(owner))
                .contentType(MediaType.APPLICATION_JSON).content(payload(CURRENT, CURRENT)))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error.code").value("password_unchanged"));
        JsonNode invalid = json.readTree(payload(CURRENT, NEXT));
        ((com.fasterxml.jackson.databind.node.ObjectNode) invalid).put("email", "other@example.test");
        http.perform(post("/api/v1/auth/password").header("Authorization", "Bearer " + token(owner))
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(invalid))).andExpect(status().isUnprocessableEntity());
    }

    @Test void limitsAttemptsPerAccountWithoutInvalidatingItsSession() throws Exception {
        var owner = account();
        for (int attempt = 0; attempt < 5; attempt++) {
            http.perform(post("/api/v1/auth/password").header("Authorization", "Bearer " + token(owner))
                    .contentType(MediaType.APPLICATION_JSON).content(payload("synthetic-incorrect-password", NEXT)))
                    .andExpect(status().isBadRequest());
        }
        http.perform(post("/api/v1/auth/password").header("Authorization", "Bearer " + token(owner))
                .contentType(MediaType.APPLICATION_JSON).content(payload(CURRENT, NEXT)))
                .andExpect(status().isTooManyRequests());
        assertThat(store.authenticate(token(owner)).get("id")).isEqualTo(userId(owner));
    }

    @Test void seededOwnerCanChangeWithoutOpeningReservedRegistration() throws Exception {
        var owner = store.register("owner-password@example.test", CURRENT);
        http.perform(post("/api/v1/auth/password").header("Authorization", "Bearer " + token(owner))
                .contentType(MediaType.APPLICATION_JSON).content(payload(CURRENT, NEXT))).andExpect(status().isOk());
        http.perform(post("/api/v1/auth/register").contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("email", "owner-password@example.test", "password", NEXT))))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.error.code").value("email_reserved"));
    }

    @Test void concurrentOldPasswordLoginCannotSurvivePasswordRotation() throws Exception {
        for (int attempt = 0; attempt < 3; attempt++) {
            var owner = account();
            var ready = new CountDownLatch(2);
            var start = new CountDownLatch(1);
            var executor = Executors.newFixedThreadPool(2);
            try {
                var login = executor.submit(() -> {
                    ready.countDown(); start.await();
                    try { return token(store.login(email(owner), CURRENT)); }
                    catch (ApiException exception) { assertThat(exception.code()).isEqualTo("invalid_credentials"); return null; }
                });
                var rotation = executor.submit(() -> {
                    ready.countDown(); start.await();
                    store.changePassword(userId(owner), CURRENT, NEXT);
                    return true;
                });
                assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
                start.countDown();
                assertThat(rotation.get(15, TimeUnit.SECONDS)).isTrue();
                String oldSession = login.get(15, TimeUnit.SECONDS);
                if (oldSession != null) assertThatThrownBy(() -> store.authenticate(oldSession)).isInstanceOf(ApiException.class);
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM sessions WHERE user_id=?", Integer.class, userId(owner))).isZero();
                assertThat(store.login(email(owner), NEXT)).containsKey("access_token");
            } finally {
                start.countDown();
                executor.shutdownNow();
            }
        }
    }
}
