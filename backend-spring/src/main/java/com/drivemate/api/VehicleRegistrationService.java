package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class VehicleRegistrationService {
    private static final Pattern YEAR = Pattern.compile("(?<![0-9])(19[0-9]{2}|20[0-9]{2}|2100)(?![0-9])");
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final VehicleCatalogService catalog;

    public VehicleRegistrationService(JdbcTemplate jdbc, TransactionTemplate transactions, VehicleCatalogService catalog) {
        this.jdbc = jdbc;
        this.transactions = transactions;
        this.catalog = catalog;
    }

    public List<Map<String, Object>> list(String userId) {
        return jdbc.query("SELECT * FROM registered_vehicles WHERE user_id=? ORDER BY created_at,vehicle_id", this::vehicle, userId);
    }

    public Map<String, Object> save(String userId, String id, JsonNode body) {
        validate(id, body);
        String catalogId = body.has("catalogId") ? body.get("catalogId").textValue() : null;
        return transactions.execute(status -> {
            lockOwner(userId);
            List<Map<String, Object>> existing = jdbc.query(
                    "SELECT * FROM registered_vehicles WHERE user_id=? AND vehicle_id=?", this::vehicle, userId, id);
            if (existing.isEmpty()) {
                Long count = jdbc.queryForObject("SELECT COUNT(*) FROM registered_vehicles WHERE user_id=?", Long.class, userId);
                if (count != null && count >= 3) {
                    throw new ApiException("vehicle_limit", "차량은 계정당 최대 3대까지 등록할 수 있어요.", 409);
                }
                jdbc.update("INSERT INTO registered_vehicles (user_id,vehicle_id,catalog_id,name,model,powertrain,odometer_km,created_at,updated_at)"
                                + " VALUES (?,?,?,?,?,?,?,?,?)", userId, id, catalogId, body.get("name").textValue().strip(),
                        body.get("model").textValue().strip(), body.get("powertrain").textValue(), body.get("odometerKm").doubleValue(),
                        body.get("createdAt").textValue(), Instant.now().toString());
            } else {
                // The identity and original registration timestamp are immutable on updates.
                jdbc.update("UPDATE registered_vehicles SET catalog_id=?,name=?,model=?,powertrain=?,odometer_km=?,updated_at=?"
                                + " WHERE user_id=? AND vehicle_id=?", catalogId, body.get("name").textValue().strip(),
                        body.get("model").textValue().strip(), body.get("powertrain").textValue(), body.get("odometerKm").doubleValue(),
                        Instant.now().toString(), userId, id);
            }
            return jdbc.queryForObject("SELECT * FROM registered_vehicles WHERE user_id=? AND vehicle_id=?", this::vehicle, userId, id);
        });
    }

    public void delete(String userId, String id) {
        validId(id);
        transactions.executeWithoutResult(status -> {
            lockOwner(userId);
            jdbc.update("DELETE FROM registered_vehicles WHERE user_id=? AND vehicle_id=?", userId, id);
        });
    }

    private void lockOwner(String userId) {
        List<String> owners = jdbc.queryForList("SELECT id FROM accounts WHERE id=? FOR UPDATE", String.class, userId);
        if (owners.isEmpty()) throw new ApiException("unauthorized", "로그인이 필요해요.", 401);
    }

    private void validate(String id, JsonNode body) {
        validId(id);
        SnapshotValidator.fields(body, Set.of("id", "name", "model", "powertrain", "odometerKm", "createdAt"), Set.of("catalogId"));
        if (!id.equals(text(body, "id", 100))) throw ApiException.invalid();
        text(body, "name", 60);
        String model = text(body, "model", 100);
        String powertrain = text(body, "powertrain", 3);
        if (!Set.of("ICE", "HYB", "EV").contains(powertrain)) throw ApiException.invalid();
        SnapshotValidator.number(body, "odometerKm", 0, 2_000_000);
        text(body, "createdAt", 40);
        SnapshotValidator.timestamp(body, "createdAt");
        if (body.has("catalogId")) {
            String catalogId = text(body, "catalogId", 80);
            VehicleCatalogEntry entry;
            try {
                entry = catalog.find(catalogId);
            } catch (ApiException exception) {
                throw new ApiException("invalid_vehicle_catalog", "선택한 차종 정보를 다시 확인해 주세요.", 422);
            }
            var year = YEAR.matcher(model);
            boolean compatible = year.find();
            int modelYear = compatible ? Integer.parseInt(year.group(1)) : 0;
            compatible = compatible && !year.find() && modelYear >= entry.yearFrom()
                    && (entry.yearTo() == null || modelYear <= entry.yearTo())
                    && entry.powertrains().contains(powertrain)
                    && normalize(model).contains(normalize(entry.model()));
            if (!compatible) {
                throw new ApiException("vehicle_catalog_mismatch", "선택한 차종의 모델명·연식·구동 방식을 확인해 주세요.", 422);
            }
        }
    }

    private static String normalize(String value) {
        return value.replaceAll("\\s+", "").toLowerCase(java.util.Locale.ROOT);
    }

    private static void validId(String id) {
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,100}")) throw ApiException.invalid();
    }

    private static String text(JsonNode body, String name, int maximum) {
        String value = SnapshotValidator.text(body, name, maximum);
        if (value.chars().anyMatch(character -> character < 32)) throw ApiException.invalid();
        return value;
    }

    private Map<String, Object> vehicle(ResultSet row, int index) throws SQLException {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("id", row.getString("vehicle_id"));
        value.put("name", row.getString("name"));
        value.put("model", row.getString("model"));
        value.put("powertrain", row.getString("powertrain"));
        value.put("odometerKm", row.getDouble("odometer_km"));
        value.put("createdAt", row.getString("created_at"));
        String catalogId = row.getString("catalog_id");
        if (catalogId != null) value.put("catalogId", catalogId);
        return value;
    }
}
