package com.drivemate.api;

import com.drivemate.api.providers.HyundaiSampleProvider;
import com.drivemate.api.providers.ProviderException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:hyundaisampletest;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "DRIVEMATE_PROVIDER_MODE=mock"
})
@AutoConfigureMockMvc
class HyundaiSampleApiTest {
    private static final String PATH = "/api/v1/vehicles/hyundai-sample";
    @Autowired MockMvc http;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired Store store;
    @Autowired VehicleRegistrationService vehicles;
    @Autowired HyundaiSampleService samples;
    @MockitoBean HyundaiSampleProvider provider;

    @BeforeEach void response() {
        reset(provider);
        when(provider.fetch("EV")).thenReturn(sample(12500));
    }

    private Map<String, Object> sample(double odometer) {
        return Map.of("source", "hyundai_sample", "is_mock", true, "is_sample", true,
                "vehicle_profile_source", "user_selected_app_category", "provider_vehicle_id", "sample-provider-car",
                "model", "Hyundai sample model", "powertrain", "EV", "odometer_km", odometer,
                "received_at", Instant.now().toString());
    }

    private String token() {
        return (String) store.register(UUID.randomUUID() + "@example.test", "hyundai-sample-test-password").get("access_token");
    }

    private String owner(String token) { return (String) store.authenticate(token).get("id"); }

    private ObjectNode vehicle(String id) {
        return json.createObjectNode().put("id", id).put("name", "My existing car").put("model", "Manual model")
                .put("powertrain", "ICE").put("odometerKm", 999).put("createdAt", "2026-11-01T00:00:00Z");
    }

    private JsonNode refresh(String token) throws Exception {
        return json.readTree(http.perform(post(PATH).param("powertrain", "EV").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk()).andExpect(jsonPath("$.status.source").value("hyundai_sample"))
                .andExpect(jsonPath("$.status.is_mock").value(true)).andReturn().getResponse().getContentAsString());
    }

    @Test void loginRequiredAndClientCannotChooseOwnerOrSupplyData() throws Exception {
        http.perform(post(PATH)).andExpect(status().isUnauthorized());
        http.perform(get(PATH)).andExpect(status().isUnauthorized());
        verifyNoInteractions(provider);
        String token = token();
        http.perform(post(PATH).header("Authorization", "Bearer " + token)).andExpect(status().isUnprocessableEntity());
        http.perform(post(PATH).param("powertrain", "OTHER").header("Authorization", "Bearer " + token))
                .andExpect(status().isUnprocessableEntity());
        http.perform(post(PATH).param("powertrain", "EV").header("Authorization", "Bearer " + token).contentType(MediaType.APPLICATION_JSON)
                .content("{\"ownerId\":\"other-account\",\"odometer_km\":1}"))
                .andExpect(status().isUnprocessableEntity());
        verifyNoInteractions(provider);
        assertThat(vehicles.list(owner(token))).isEmpty();
    }

    @Test void persistsAcrossLoginsAndKeepsAccountsAndNormalVehiclesSeparate() throws Exception {
        String first = token(), second = token();
        String firstOwner = owner(first);
        vehicles.save(firstOwner, "normal-car", vehicle("normal-car"));
        JsonNode firstResult = refresh(first);
        http.perform(get(PATH).header("Authorization", "Bearer " + second)).andExpect(status().isNotFound());
        JsonNode secondResult = refresh(second);
        assertThat(firstResult.path("vehicle").path("id").asText())
                .isNotEqualTo(secondResult.path("vehicle").path("id").asText());
        assertThat(vehicles.list(firstOwner)).hasSize(2);
        assertThat(vehicles.list(firstOwner).stream().filter(value -> value.get("id").equals("normal-car")).findFirst().orElseThrow())
                .containsEntry("odometerKm", 999.0);
        String email = (String) store.authenticate(first).get("email");
        store.logout(first);
        String nextSession = (String) store.login(email, "hyundai-sample-test-password").get("access_token");
        http.perform(get(PATH).header("Authorization", "Bearer " + nextSession)).andExpect(status().isOk())
                .andExpect(jsonPath("$.vehicle.id").value(firstResult.path("vehicle").path("id").asText()))
                .andExpect(jsonPath("$.status.odometer_km").value(12500.0));
        verify(provider, times(2)).fetch("EV"); // Reading the stored copy does not call Hyundai.
    }

    @Test void repeatedImportRefreshesAbsoluteReadingAndPreservesIdentityNameAndCreatedAt() throws Exception {
        String token = token();
        JsonNode initial = refresh(token);
        String id = initial.path("vehicle").path("id").asText();
        ObjectNode renamed = (ObjectNode) initial.path("vehicle").deepCopy();
        renamed.put("name", "My named sample");
        vehicles.save(owner(token), id, renamed);
        when(provider.fetch("EV")).thenReturn(sample(12600));
        JsonNode updated = refresh(token);
        assertThat(updated.path("vehicle").path("id").asText()).isEqualTo(id);
        assertThat(updated.path("vehicle").path("createdAt")).isEqualTo(initial.path("vehicle").path("createdAt"));
        assertThat(updated.path("vehicle").path("name").asText()).isEqualTo("My named sample");
        assertThat(updated.path("vehicle").path("odometerKm").asDouble()).isEqualTo(12600);
        assertThat(vehicles.list(owner(token))).hasSize(1);
    }

    @Test void failedOrMalformedProviderResponseLeavesPreviousDataUntouched() throws Exception {
        String token = token();
        JsonNode initial = refresh(token);
        when(provider.fetch("EV")).thenThrow(new ProviderException("provider_unavailable", "Provider unavailable", 502));
        http.perform(post(PATH).param("powertrain", "EV").header("Authorization", "Bearer " + token))
                .andExpect(status().isBadGateway()).andExpect(jsonPath("$.error.code").value("provider_unavailable"));
        JsonNode stored = json.readTree(http.perform(get(PATH).header("Authorization", "Bearer " + token))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
        assertThat(stored).isEqualTo(initial);
        reset(provider);
        when(provider.fetch("EV")).thenReturn(sample(-1));
        http.perform(post(PATH).param("powertrain", "EV").header("Authorization", "Bearer " + token)).andExpect(status().isBadGateway());
        assertThat(samples.get(owner(token)).get("status")).isEqualTo(initial.path("status"));
    }

    @Test void fullAccountDoesNotCreateAnOrphanSnapshot() throws Exception {
        String token = token();
        String owner = owner(token);
        for (int index = 0; index < 3; index++) vehicles.save(owner, "normal-" + index, vehicle("normal-" + index));
        http.perform(post(PATH).param("powertrain", "EV").header("Authorization", "Bearer " + token)).andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("vehicle_limit"));
        assertThat(vehicles.list(owner)).hasSize(3);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM vehicle_sample_status WHERE user_id=?", Long.class, owner)).isZero();
    }

    @Test void providerConfigurationRateLimitAndTimeoutKeepTheirPublicStatus() throws Exception {
        String token = token();
        var failures = List.of(
                new ProviderException("hyundai_sample_not_configured", "Sample configuration missing", 503),
                new ProviderException("provider_rate_limited", "Provider limit reached", 429, true, null, 30.0),
                new ProviderException("provider_timeout", "Provider timed out", 504, true, null, null));
        for (ProviderException failure : failures) {
            doThrow(failure).when(provider).fetch("EV");
            http.perform(post(PATH).param("powertrain", "EV").header("Authorization", "Bearer " + token))
                    .andExpect(status().is(failure.status()))
                    .andExpect(jsonPath("$.error.code").value(failure.code()))
                    .andExpect(jsonPath("$.error.retryable").value(failure.retryable()))
                    .andExpect(header().string("Cache-Control", "no-store"));
        }
        assertThat(vehicles.list(owner(token))).isEmpty();
        http.perform(get(PATH).header("Authorization", "Bearer " + token)).andExpect(status().isNotFound());
    }

    @Test void concurrentImportsCreateOneSampleWithinTheVehicleLimit() throws Exception {
        String owner = owner(token());
        vehicles.save(owner, "normal-one", vehicle("normal-one"));
        vehicles.save(owner, "normal-two", vehicle("normal-two"));
        CountDownLatch ready = new CountDownLatch(2), start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(2);
        try {
            var results = List.of(1, 2).stream().map(index -> executor.submit(() -> {
                ready.countDown();
                start.await();
                return samples.refresh(owner, "EV");
            })).toList();
            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            assertThat(results.get(0).get(10, TimeUnit.SECONDS).get("vehicle"))
                    .isEqualTo(results.get(1).get(10, TimeUnit.SECONDS).get("vehicle"));
            assertThat(vehicles.list(owner)).hasSize(3);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM vehicle_sample_status WHERE user_id=?", Long.class, owner)).isEqualTo(1);
        } finally {
            start.countDown();
            executor.shutdownNow();
        }
    }

    @Test void deletingVehicleOrAccountCascadesStoredSample() throws Exception {
        String token = token();
        String owner = owner(token);
        String id = refresh(token).path("vehicle").path("id").asText();
        http.perform(delete("/api/v1/vehicles/" + id).header("Authorization", "Bearer " + token)).andExpect(status().isOk());
        http.perform(get(PATH).header("Authorization", "Bearer " + token)).andExpect(status().isNotFound());
        refresh(token);
        http.perform(delete("/api/v1/account").header("Authorization", "Bearer " + token)).andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM vehicle_sample_status WHERE user_id=?", Long.class, owner)).isZero();
    }
}
