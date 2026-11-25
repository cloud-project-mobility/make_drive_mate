package com.drivemate.api;

import com.drivemate.api.providers.HyundaiSampleProvider;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.format.ResolverStyle;
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
    private static final DateTimeFormatter PROVIDER_TIME =
            DateTimeFormatter.ofPattern("uuuuMMddHHmmss").withResolverStyle(ResolverStyle.STRICT);
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
            vehicles.lockOwner(userId);
            StoredSample previous = findStored(userId);
            String savedAt = Instant.now().toString();
            String model = sample.get("model").textValue();
            double kilometres = sample.get("odometer_km").doubleValue();
            if (previous == null) {
                String id = UUID.randomUUID().toString();
                ObjectNode registration = json.createObjectNode().put("id", id).put("name", "현대 샘플 차량")
                        .put("model", model).put("powertrain", powertrain).put("odometerKm", kilometres).put("createdAt", savedAt);
                vehicles.insertSampleWhileLocked(userId, id, registration);
                jdbc.update("INSERT INTO vehicle_sample_status (user_id,vehicle_id,source,body,saved_at) VALUES (?,?,?,?,?)",
                        userId, id, SOURCE, sample.toString(), savedAt);
            } else {
                if (!shouldReplace(previous.status(), sample)) return previous.response();
                String id = (String) previous.vehicle().get("id");
                // Keep user-edited names and registration dates. A catalog link only applies to the same model and powertrain.
                jdbc.update("UPDATE registered_vehicles SET catalog_id=CASE WHEN model=? AND powertrain=? THEN catalog_id ELSE NULL END,"
                                + "model=?,powertrain=?,odometer_km=?,updated_at=? WHERE user_id=? AND vehicle_id=?",
                        model, powertrain, model, powertrain, kilometres, savedAt, userId, id);
                jdbc.update("UPDATE vehicle_sample_status SET body=?,saved_at=? WHERE user_id=? AND vehicle_id=? AND source=?",
                        sample.toString(), savedAt, userId, id, SOURCE);
            }
            return get(userId);
        });
    }

    private static boolean shouldReplace(JsonNode previous, JsonNode next) {
        if (!previous.get("provider_vehicle_id").equals(next.get("provider_vehicle_id"))) {
            throw new ApiException("hyundai_sample_vehicle_changed", "기존에 연결된 샘플 차량을 확인해 주세요.", 409);
        }
        String oldTime = previous.path("provider_timestamp_raw").asText(null);
        String nextTime = next.path("provider_timestamp_raw").asText(null);
        int receiptOrder = Instant.parse(next.get("received_at").textValue())
                .compareTo(Instant.parse(previous.get("received_at").textValue()));
        if (oldTime != null && nextTime == null) return false;
        // Strictly validated fixed-width provider clocks are comparable for the same vehicle, without guessing a zone.
        int order = oldTime != null ? nextTime.compareTo(oldTime) : receiptOrder;
        if (order < 0) return false;
        int distanceOrder = next.get("odometer_km").decimalValue().compareTo(previous.get("odometer_km").decimalValue());
        if (distanceOrder < 0 || (order == 0 && distanceOrder != 0)) {
            throw new ApiException("hyundai_sample_odometer_conflict", "누적거리 값이 이전 관측과 맞지 않아 기존 기록을 유지했어요.", 409);
        }
        // A repeat observation may still carry a deliberate choice of a different app vehicle category.
        return order > 0 || (oldTime == null && nextTime != null)
                || (receiptOrder > 0 && !next.get("powertrain").equals(previous.get("powertrain")));
    }

    private record StoredSample(Map<String, Object> vehicle, JsonNode status) {
        Map<String, Object> response() { return Map.of("vehicle", vehicle, "status", status); }
    }

    public Map<String, Object> get(String userId) {
        StoredSample stored = findStored(userId);
        if (stored == null) throw new ApiException("hyundai_sample_not_found", "계정에 저장된 현대 샘플 차량이 없어요.", 404);
        return stored.response();
    }

    private StoredSample findStored(String userId) {
        List<StoredSample> results = jdbc.query(
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
                        return new StoredSample(vehicle, sample);
                    } catch (IOException error) {
                        throw new IllegalStateException("Stored Hyundai sample is invalid", error);
                    }
                }, userId, SOURCE);
        return results.isEmpty() ? null : results.get(0);
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
            if (sample.hasNonNull("provider_timestamp_raw")) {
                JsonNode timestamp = sample.get("provider_timestamp_raw");
                if (!timestamp.isTextual() || !timestamp.textValue().matches("[0-9]{14}")) throw malformed();
                LocalDateTime.parse(timestamp.textValue(), PROVIDER_TIME);
            }
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
