package com.drivemate.api;

import com.drivemate.api.providers.HyundaiSampleProvider;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class HyundaiSampleService {
    private static final String SOURCE = "hyundai_sample";
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final ObjectMapper json;
    private final VehicleRegistrationService vehicles;
    private final HyundaiSampleProvider provider;

    public HyundaiSampleService(JdbcTemplate jdbc, TransactionTemplate transactions, ObjectMapper json,
            VehicleRegistrationService vehicles, HyundaiSampleProvider provider) {
        this.jdbc = jdbc;
        this.transactions = transactions;
        this.json = json;
        this.vehicles = vehicles;
        this.provider = provider;
    }

    public Map<String, Object> refresh(String userId, String powertrain) {
        if (powertrain == null || !Set.of("ICE", "HYB", "EV").contains(powertrain)) throw ApiException.invalid();
        // Network calls and response validation must finish before holding the account lock.
        JsonNode sample = json.valueToTree(provider.fetch(powertrain));
        validate(sample);
        if (!powertrain.equals(sample.get("powertrain").textValue())) throw malformed();
        return transactions.execute(transaction -> {
            List<String> owners = jdbc.queryForList("SELECT id FROM accounts WHERE id=? FOR UPDATE", String.class, userId);
            if (owners.isEmpty()) throw new ApiException("unauthorized", "로그인이 필요해요.", 401);
            List<String> ids = jdbc.queryForList(
                    "SELECT vehicle_id FROM vehicle_sample_status WHERE user_id=? AND source=?", String.class, userId, SOURCE);
            String id = ids.isEmpty() ? UUID.randomUUID().toString() : ids.get(0);
            Map<String, Object> previous = ids.isEmpty() ? null : vehicles.list(userId).stream()
                    .filter(vehicle -> id.equals(vehicle.get("id"))).findFirst().orElseThrow();
            ObjectNode registration = json.createObjectNode();
            registration.put("id", id).put("name", previous == null ? "현대 샘플 차량" : (String) previous.get("name"))
                    .put("model", sample.get("model").textValue()).put("powertrain", sample.get("powertrain").textValue())
                    .put("odometerKm", sample.get("odometer_km").doubleValue())
                    .put("createdAt", previous == null ? Instant.now().toString() : (String) previous.get("createdAt"));
            Map<String, Object> vehicle = vehicles.save(userId, id, registration);
            String savedAt = Instant.now().toString();
            if (ids.isEmpty()) {
                jdbc.update("INSERT INTO vehicle_sample_status (user_id,vehicle_id,source,body,saved_at) VALUES (?,?,?,?,?)",
                        userId, id, SOURCE, sample.toString(), savedAt);
            } else {
                jdbc.update("UPDATE vehicle_sample_status SET body=?,saved_at=? WHERE user_id=? AND vehicle_id=? AND source=?",
                        sample.toString(), savedAt, userId, id, SOURCE);
            }
            return Map.of("vehicle", vehicle, "status", sample);
        });
    }

    public Map<String, Object> get(String userId) {
        List<Map<String, Object>> results = jdbc.query(
                "SELECT v.*,s.body FROM registered_vehicles v JOIN vehicle_sample_status s"
                        + " ON v.user_id=s.user_id AND v.vehicle_id=s.vehicle_id WHERE v.user_id=? AND s.source=?",
                (row, index) -> {
                    Map<String, Object> vehicle = new LinkedHashMap<>();
                    vehicle.put("id", row.getString("vehicle_id"));
                    vehicle.put("name", row.getString("name"));
                    vehicle.put("model", row.getString("model"));
                    vehicle.put("powertrain", row.getString("powertrain"));
                    vehicle.put("odometerKm", row.getDouble("odometer_km"));
                    vehicle.put("createdAt", row.getString("created_at"));
                    String catalogId = row.getString("catalog_id");
                    if (catalogId != null) vehicle.put("catalogId", catalogId);
                    try {
                        JsonNode sample = json.readTree(row.getString("body"));
                        validate(sample);
                        return Map.<String, Object>of("vehicle", vehicle, "status", sample);
                    } catch (IOException error) {
                        throw new IllegalStateException("Stored Hyundai sample is invalid", error);
                    }
                }, userId, SOURCE);
        if (results.isEmpty()) throw new ApiException("hyundai_sample_not_found", "계정에 저장된 현대 샘플 차량이 없어요.", 404);
        return results.get(0);
    }

    private static void validate(JsonNode sample) {
        if (sample == null || !sample.isObject() || !SOURCE.equals(sample.path("source").asText())
                || !sample.path("is_mock").isBoolean() || !sample.path("is_mock").booleanValue()
                || !sample.path("is_sample").isBoolean() || !sample.path("is_sample").booleanValue()
                || !"user_selected_app_category".equals(sample.path("vehicle_profile_source").asText())
                || !validText(sample.get("provider_vehicle_id"), 200) || !validText(sample.get("model"), 100)
                || !Set.of("ICE", "HYB", "EV").contains(sample.path("powertrain").asText())
                || !sample.path("odometer_km").isNumber() || !Double.isFinite(sample.path("odometer_km").doubleValue())
                || sample.path("odometer_km").doubleValue() < 0 || sample.path("odometer_km").doubleValue() > 2_000_000
                || !validText(sample.get("received_at"), 40)) throw malformed();
        try {
            Instant.parse(sample.get("received_at").textValue());
        } catch (DateTimeParseException error) {
            throw malformed();
        }
    }

    private static boolean validText(JsonNode value, int maximum) {
        return value != null && value.isTextual() && !value.textValue().isBlank() && value.textValue().length() <= maximum
                && value.textValue().chars().noneMatch(character -> character < 32);
    }

    private static ApiException malformed() {
        return new ApiException("provider_malformed_response", "현대 샘플 응답 형식을 확인할 수 없어요.", 502);
    }
}
