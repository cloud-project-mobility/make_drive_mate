package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:vehiclecatalogtest;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "DRIVEMATE_PROVIDER_MODE=mock"
})
@AutoConfigureMockMvc
class VehicleCatalogApiTest {
    @Autowired MockMvc http;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired VehicleCatalogService catalog;
    @Autowired VehicleRegistrationService vehicles;
    @Autowired Store store;

    private String token() {
        return (String) store.register(UUID.randomUUID() + "@example.test", "catalog-test-password-2026").get("access_token");
    }

    private VehicleCatalogEntry firstEntry() {
        String id = jdbc.queryForObject("SELECT id FROM vehicle_catalog ORDER BY id LIMIT 1", String.class);
        return catalog.find(id);
    }

    private ObjectNode vehicle(String id, boolean withCatalog) {
        VehicleCatalogEntry entry = firstEntry();
        ObjectNode value = json.createObjectNode();
        value.put("id", id).put("name", "등록한 내 차")
                .put("model", entry.manufacturer() + " " + entry.model() + " " + entry.yearFrom())
                .put("powertrain", entry.powertrains().get(0)).put("odometerKm", 12345)
                .put("createdAt", "2026-11-04T00:00:00Z");
        if (withCatalog) value.put("catalogId", entry.id());
        return value;
    }

    @Test void catalogIsPublicFilteredBoundedAndDoesNotExposePrivateVehicles() throws Exception {
        VehicleCatalogEntry entry = firstEntry();
        http.perform(get("/api/v1/vehicle-catalog").param("limit", "1"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.vehicles.length()").value(1))
                .andExpect(jsonPath("$.vehicles[0].imageSourceUrl").isString())
                .andExpect(jsonPath("$.vehicles[0].imageLicenseUrl").isString())
                .andExpect(jsonPath("$.vehicles[0].representative").value(true))
                .andExpect(jsonPath("$.vehicles[0].userId").doesNotExist());
        http.perform(get("/api/v1/vehicle-catalog").param("manufacturer", entry.manufacturer()).param("query", entry.model()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.vehicles[0].manufacturer").value(entry.manufacturer()))
                .andExpect(jsonPath("$.vehicles[0].model").value(entry.model()));
        http.perform(get("/api/v1/vehicle-catalog").param("query", "%_!' OR 1=1--"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(0));
        http.perform(get("/api/v1/vehicle-catalog").param("limit", "101")).andExpect(status().isUnprocessableEntity());
        http.perform(get("/api/v1/vehicle-catalog").param("query", "x".repeat(101))).andExpect(status().isUnprocessableEntity());
    }

    @Test void onlyCatalogMappedPackagedImagesAreServedWithCorrectTypeAndCache() throws Exception {
        VehicleCatalogEntry entry = firstEntry();
        http.perform(get("/api/v1/vehicle-catalog/" + entry.id()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.imageObjectKey").value(entry.imageObjectKey()))
                .andExpect(jsonPath("$.imageUrl").value("/api/v1/vehicle-catalog/" + entry.id() + "/image"));
        byte[] bytes = http.perform(get(entry.imageUrl())).andExpect(status().isOk())
                .andExpect(content().contentType(catalog.imageType(entry)))
                .andExpect(header().string("Cache-Control", "max-age=3600, public"))
                .andExpect(header().string("X-Content-Type-Options", "nosniff")).andReturn().getResponse().getContentAsByteArray();
        assertThat(bytes.length).isGreaterThan(8);
        if (entry.imageObjectKey().endsWith(".png")) assertThat(bytes[0] & 255).isEqualTo(137);
        else assertThat(bytes[0] & 255).isEqualTo(255);
        http.perform(get("/api/v1/vehicle-catalog/not-a-known-model/image")).andExpect(status().isNotFound());
        assertThrows(ApiException.class, () -> catalog.find("../application.properties"));
        jdbc.update("UPDATE vehicle_catalog SET image_object_key='../application.properties' WHERE id=?", entry.id());
        try {
            http.perform(get(entry.imageUrl())).andExpect(status().isNotFound());
        } finally {
            catalog.seed();
        }
    }

    @Test void seedingTwiceUpdatesMetadataWithoutDuplicatingRowsOrChangingUserData() {
        VehicleCatalogEntry entry = firstEntry();
        String token = token();
        String owner = (String) store.authenticate(token).get("id");
        vehicles.save(owner, "seed-owned-vehicle", vehicle("seed-owned-vehicle", true));
        Long total = jdbc.queryForObject("SELECT COUNT(*) FROM vehicle_catalog", Long.class);
        jdbc.update("UPDATE vehicle_catalog SET note='outdated photo metadata' WHERE id=?", entry.id());
        catalog.seed();
        catalog.seed();
        assertThat(catalog.find(entry.id()).note()).isEqualTo(entry.note());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM vehicle_catalog", Long.class)).isEqualTo(total);
        assertThat(vehicles.list(owner)).hasSize(1);
    }

    @Test void registrationsRequireLoginAndRemainAccountScoped() throws Exception {
        http.perform(get("/api/v1/vehicles")).andExpect(status().isUnauthorized());
        http.perform(put("/api/v1/vehicles/car").contentType(MediaType.APPLICATION_JSON).content(vehicle("car", true).toString()))
                .andExpect(status().isUnauthorized());
        http.perform(delete("/api/v1/vehicles/car")).andExpect(status().isUnauthorized());
        String first = token();
        String second = token();
        ObjectNode body = vehicle("shared-local-id", true);
        http.perform(put("/api/v1/vehicles/shared-local-id").header("Authorization", "Bearer " + first)
                .contentType(MediaType.APPLICATION_JSON).content(body.toString()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.vehicle.catalogId").value(body.get("catalogId").textValue()));
        http.perform(get("/api/v1/vehicles").header("Authorization", "Bearer " + second))
                .andExpect(status().isOk()).andExpect(jsonPath("$.vehicles.length()").value(0));
        http.perform(delete("/api/v1/vehicles/shared-local-id").header("Authorization", "Bearer " + second))
                .andExpect(status().isOk());
        http.perform(get("/api/v1/vehicles").header("Authorization", "Bearer " + first))
                .andExpect(status().isOk()).andExpect(jsonPath("$.vehicles.length()").value(1));
    }

    @Test void registrationUpsertsPreserveIdentityAndEnforceTheThreeVehicleLimit() throws Exception {
        String token = token();
        for (int index = 0; index < 3; index++) {
            String id = "car-" + index;
            http.perform(put("/api/v1/vehicles/" + id).header("Authorization", "Bearer " + token)
                    .contentType(MediaType.APPLICATION_JSON).content(vehicle(id, true).toString())).andExpect(status().isOk());
        }
        ObjectNode updated = vehicle("car-0", true).put("name", "바꾼 차량 이름").put("odometerKm", 13000)
                .put("createdAt", "2026-11-05T00:00:00Z");
        http.perform(put("/api/v1/vehicles/car-0").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON).content(updated.toString()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.vehicle.name").value("바꾼 차량 이름"))
                .andExpect(jsonPath("$.vehicle.createdAt").value("2026-11-04T00:00:00Z"));
        http.perform(put("/api/v1/vehicles/car-3").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON).content(vehicle("car-3", false).toString()))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.error.code").value("vehicle_limit"));
        http.perform(get("/api/v1/vehicles").header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$.vehicles.length()").value(3));
        http.perform(delete("/api/v1/vehicles/car-1").header("Authorization", "Bearer " + token)).andExpect(status().isOk());
        http.perform(delete("/api/v1/vehicles/car-1").header("Authorization", "Bearer " + token)).andExpect(status().isOk());
        http.perform(put("/api/v1/vehicles/car-3").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON).content(vehicle("car-3", false).toString()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.vehicle.catalogId").doesNotExist());
    }

    @Test void incompatibleCatalogDataAndUnknownFieldsCannotCreateVehicles() throws Exception {
        String token = token();
        ObjectNode body = vehicle("invalid", true);
        body.put("catalogId", "not-a-known-model");
        http.perform(put("/api/v1/vehicles/invalid").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON).content(body.toString())).andExpect(status().isUnprocessableEntity());
        body = vehicle("invalid", true).put("model", firstEntry().model() + " 1950");
        http.perform(put("/api/v1/vehicles/invalid").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON).content(body.toString())).andExpect(status().isUnprocessableEntity());
        body = vehicle("invalid", true).put("model", "다른 차량 " + firstEntry().yearFrom());
        http.perform(put("/api/v1/vehicles/invalid").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON).content(body.toString())).andExpect(status().isUnprocessableEntity());
        body = vehicle("invalid", true).put("powertrain", firstEntry().powertrains().contains("EV") ? "ICE" : "EV");
        http.perform(put("/api/v1/vehicles/invalid").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON).content(body.toString())).andExpect(status().isUnprocessableEntity());
        body = vehicle("invalid", false).put("ownerId", "someone-else");
        http.perform(put("/api/v1/vehicles/invalid").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON).content(body.toString())).andExpect(status().isUnprocessableEntity());
        http.perform(put("/api/v1/vehicles/path-id").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON).content(vehicle("body-id", false).toString())).andExpect(status().isUnprocessableEntity());
        http.perform(get("/api/v1/vehicles").header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$.vehicles.length()").value(0));
    }

    @Test void concurrentRegistrationsCannotExceedTheAccountLimit() throws Exception {
        String token = token();
        String owner = (String) store.authenticate(token).get("id");
        vehicles.save(owner, "existing-one", vehicle("existing-one", false));
        vehicles.save(owner, "existing-two", vehicle("existing-two", false));
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(2);
        try {
            var results = List.of("new-one", "new-two").stream().map(id -> executor.submit(() -> {
                ready.countDown();
                start.await();
                try {
                    vehicles.save(owner, id, vehicle(id, false));
                    return "saved";
                } catch (ApiException exception) {
                    return exception.code();
                }
            })).toList();
            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            assertThat(List.of(results.get(0).get(10, TimeUnit.SECONDS), results.get(1).get(10, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder("saved", "vehicle_limit");
            assertThat(vehicles.list(owner)).hasSize(3);
        } finally {
            start.countDown();
            executor.shutdownNow();
        }
    }

    @Test void deletingAnAccountCascadesItsRegistrationsButKeepsThePublicCatalog() throws Exception {
        String token = token();
        String owner = (String) store.authenticate(token).get("id");
        vehicles.save(owner, "deleted-with-account", vehicle("deleted-with-account", true));
        Long count = jdbc.queryForObject("SELECT COUNT(*) FROM vehicle_catalog", Long.class);
        http.perform(delete("/api/v1/account").header("Authorization", "Bearer " + token)).andExpect(status().isOk());
        assertThat(vehicles.list(owner)).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM vehicle_catalog", Long.class)).isEqualTo(count);
    }

    @Test void backupsRoundTripCatalogIdsAndRejectNullOrUnsafeIds() throws Exception {
        String token = token();
        ObjectNode state = (ObjectNode) json.readTree("""
                {"version":1,"vehicles":[],"selectedVehicleId":"backup-car","trips":[],"plans":[],"maintenance":[],
                 "activeTrip":null,"settings":{"walkMinutes":10,"bufferMinutes":10},"onboarded":true,"demoMode":false}
                """);
        state.withArray("vehicles").add(vehicle("backup-car", true));
        http.perform(put("/api/v1/state").header("Authorization", "Bearer " + token).contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("expected_revision", 0, "state", state))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.state.vehicles[0].catalogId").value(firstEntry().id()));
        http.perform(get("/api/v1/state").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk()).andExpect(jsonPath("$.state.vehicles[0].catalogId").value(firstEntry().id()));
        for (JsonNode invalid : List.of(json.nullNode(), json.getNodeFactory().textNode("../private"))) {
            ((ObjectNode) state.get("vehicles").get(0)).set("catalogId", invalid);
            http.perform(put("/api/v1/state").header("Authorization", "Bearer " + token).contentType(MediaType.APPLICATION_JSON)
                    .content(json.writeValueAsString(Map.of("expected_revision", 1, "state", state))))
                    .andExpect(status().isUnprocessableEntity());
        }
    }
}
