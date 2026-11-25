package com.drivemate.api;

import com.drivemate.api.providers.HyundaiSampleProvider;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.transaction.support.TransactionTemplate;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Default H2. The optional PostgreSQL loopback database is created only by the local verification runner. */
class HyundaiSampleOrderingTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final HyundaiSampleProvider provider = mock(HyundaiSampleProvider.class);
    private final String owner = UUID.randomUUID().toString();
    private JdbcTemplate db;
    private HyundaiSampleService service;
    private VehicleRegistrationService vehicles;
    private static final String EARLIER = "2026-01-01T00:00:00Z";
    private static final String LATER = "2026-01-02T00:00:00Z";

    @BeforeEach void setUp() {
        String port = System.getenv("DRIVEMATE_TEST_PG_PORT");
        var ds = port == null
                ? new DriverManagerDataSource("jdbc:h2:mem:" + UUID.randomUUID()
                        + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1", "sa", "")
                : new DriverManagerDataSource("jdbc:postgresql://127.0.0.1:" + Integer.parseInt(port) + "/postgres",
                        "hyundai_review", System.getenv("DRIVEMATE_TEST_PG_PASSWORD"));
        new ResourceDatabasePopulator(new ClassPathResource("schema.sql")).execute(ds);
        db = new JdbcTemplate(ds);
        var tx = new TransactionTemplate(new DataSourceTransactionManager(ds));
        vehicles = new VehicleRegistrationService(db, tx, mock(VehicleCatalogService.class));
        service = new HyundaiSampleService(db, tx, mapper, vehicles, provider);
        insertOwner(owner);
    }

    private void insertOwner(String id) {
        db.update("INSERT INTO accounts (id,email,salt,password_hash,created_at) VALUES (?,?,?,?,?)",
                id, id + "@example.invalid", "unused", "unused", EARLIER);
    }

    private Map<String, Object> sample(int kilometres, String at) {
        return Map.of("source", "hyundai_sample", "is_mock", true, "is_sample", true,
                "vehicle_profile_source", "user_selected_app_category", "provider_vehicle_id", "unit-sample",
                "model", "Sample", "powertrain", "ICE", "odometer_km", kilometres, "received_at", at);
    }

    private JsonNode stored() { return mapper.valueToTree(service.get(owner)); }

    @Test void replayAndRefreshKeepOneVehicleAndOneSnapshot() {
        when(provider.fetch("ICE")).thenReturn(sample(1000, EARLIER), sample(1100, LATER), sample(1100, LATER));
        service.refresh(owner, "ICE");
        String id = stored().at("/vehicle/id").asText();
        service.refresh(owner, "ICE");
        service.refresh(owner, "ICE");
        assertEquals(id, stored().at("/vehicle/id").asText());
        assertEquals(1100, stored().at("/status/odometer_km").intValue());
        assertEquals(1100, stored().at("/vehicle/odometerKm").intValue());
        assertEquals(1, db.queryForObject("SELECT COUNT(*) FROM vehicle_sample_status WHERE user_id=?", Integer.class, owner));
        assertEquals(1, vehicles.list(owner).size());
        verify(provider, times(3)).fetch("ICE");
    }

    @Test void failedRefreshPreservesLastGoodSnapshot() {
        when(provider.fetch("ICE")).thenReturn(sample(1100, LATER)).thenThrow(new IllegalStateException("upstream unavailable"));
        service.refresh(owner, "ICE");
        JsonNode before = stored();
        assertThrows(IllegalStateException.class, () -> service.refresh(owner, "ICE"));
        assertEquals(before, stored());
    }

    @Test void manualAndSampleVehicleStaySeparateAndOtherAccountReadsNoSample() {
        String manualId = UUID.randomUUID().toString();
        vehicles.save(owner, manualId, mapper.valueToTree(Map.of("id", manualId, "name", "Manual", "model", "Manual",
                "powertrain", "ICE", "odometerKm", 9000, "createdAt", EARLIER)));
        when(provider.fetch("ICE")).thenReturn(sample(1000, EARLIER));
        service.refresh(owner, "ICE");
        assertNotEquals(manualId, stored().at("/vehicle/id").asText());
        assertEquals(2, vehicles.list(owner).size());
        assertEquals(9000, db.queryForObject("SELECT odometer_km FROM registered_vehicles WHERE vehicle_id=?",
                Double.class, manualId).intValue());
        String other = UUID.randomUUID().toString();
        insertOwner(other);
        assertThrows(ApiException.class, () -> service.get(other));
        verify(provider).fetch("ICE");
    }

    @Test void lateOlderSnapshotMustNotRollBackMileage() {
        when(provider.fetch("ICE")).thenReturn(sample(1100, LATER), sample(950, EARLIER));
        service.refresh(owner, "ICE");
        service.refresh(owner, "ICE");
        assertAll(() -> assertEquals(1100, stored().at("/vehicle/odometerKm").intValue()),
                () -> assertEquals(1100, stored().at("/status/odometer_km").intValue()));
    }

    private Map<String, Object> observed(int km, String received, String vehicleTime) {
        var snapshot = new HashMap<>(sample(km, received));
        snapshot.put("provider_timestamp_raw", vehicleTime);
        return snapshot;
    }

    private String savedAt() {
        return db.queryForObject("SELECT saved_at FROM vehicle_sample_status WHERE user_id=?", String.class, owner);
    }

    @Test void vehicleClockWinsOverReceiptAndDuplicateDoesNotWrite() {
        var newer = observed(1100, EARLIER, "20260102110000");
        var duplicate = observed(1100, LATER, "20260102110000");
        var delayed = observed(1500, LATER, "20260101090000");
        when(provider.fetch("ICE")).thenReturn(newer, duplicate, delayed);
        service.refresh(owner, "ICE");
        var before = stored();
        String committed = savedAt();
        service.refresh(owner, "ICE");
        service.refresh(owner, "ICE");
        assertEquals(before, stored());
        assertEquals(committed, savedAt());
    }

    @Test void newerDistanceRegressionAndConflictingSameInstantLeaveBothRowsUntouched() {
        when(provider.fetch("ICE")).thenReturn(observed(1100, EARLIER, "20260102110000"),
                observed(950, LATER, "20260103110000"), observed(1200, LATER, "20260102110000"));
        service.refresh(owner, "ICE");
        var before = stored();
        for (int i = 0; i < 2; i++) {
            assertThrows(ApiException.class, () -> service.refresh(owner, "ICE"));
            assertEquals(before, stored());
        }
    }

    @Test void legacyRowsCanGainAnObservationClockButCannotLoseItToMissingOrInvalidInput() {
        when(provider.fetch("ICE")).thenReturn(sample(1000, EARLIER), observed(1100, LATER, "20260102110000"),
                sample(2000, "2026-02-01T00:00:00Z"), observed(1500, LATER, "20260230000000"));
        service.refresh(owner, "ICE");
        service.refresh(owner, "ICE");
        var before = stored();
        service.refresh(owner, "ICE");
        assertThrows(ApiException.class, () -> service.refresh(owner, "ICE"));
        assertEquals(before, stored());
        assertEquals(1100, before.at("/vehicle/odometerKm").intValue());
    }

    @Test void sameLegacyReceiptCanGainTheProviderClock() {
        when(provider.fetch("ICE")).thenReturn(sample(1000, EARLIER), observed(1000, EARLIER, "20260101000000"));
        service.refresh(owner, "ICE");
        service.refresh(owner, "ICE");
        assertEquals("20260101000000", stored().at("/status/provider_timestamp_raw").textValue());
    }

    @Test void matchingObservationCanUpdateTheUserSelectedCategory() {
        var first = observed(1100, EARLIER, "20260102110000");
        var changed = observed(1100, LATER, "20260102110000");
        changed.put("powertrain", "EV");
        when(provider.fetch("ICE")).thenReturn(first);
        when(provider.fetch("EV")).thenReturn(changed);
        service.refresh(owner, "ICE");
        service.refresh(owner, "EV");
        assertEquals("EV", stored().at("/vehicle/powertrain").textValue());
        assertEquals("EV", stored().at("/status/powertrain").textValue());
    }

    @Test void requestFinishingLastCannotReplaceTheNewerObservation() throws Exception {
        var slowStarted = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        when(provider.fetch("ICE")).thenAnswer(call -> {
            slowStarted.countDown();
            if (!release.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("unexpected wait");
            return observed(950, LATER, "20260101090000");
        }).thenReturn(observed(1100, EARLIER, "20260102110000"));
        var executor = Executors.newSingleThreadExecutor();
        try {
            var slow = executor.submit(() -> service.refresh(owner, "ICE"));
            assertTrue(slowStarted.await(5, TimeUnit.SECONDS));
            service.refresh(owner, "ICE");
            release.countDown();
            slow.get(5, TimeUnit.SECONDS);
            assertEquals(1100, stored().at("/vehicle/odometerKm").intValue());
            assertEquals("20260102110000", stored().at("/status/provider_timestamp_raw").textValue());
        } finally {
            release.countDown();
            executor.shutdownNow();
        }
    }
}
