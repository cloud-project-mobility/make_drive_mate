package com.drivemate.api.providers;

import static com.drivemate.api.providers.ProviderSupport.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.time.format.ResolverStyle;
import java.util.*;
import org.springframework.stereotype.Service;

@Service
public class HyundaiProvider {
    private final ProviderSettings settings;
    private final ObjectMapper mapper;
    public HyundaiProvider(ProviderSettings settings, ObjectMapper mapper) { this.settings = settings; this.mapper = mapper; }
    public static Map<String, Object> normalizeOdometer(JsonNode payload, Instant receivedAt) {
        try {
            if (payload == null || !payload.isObject()) throw new IllegalArgumentException();
            for (String key : List.of("error", "errors", "errCode", "errMsg", "errId")) if (payload.has(key)) throw new IllegalArgumentException();
            text(payload.get("msgId"), 1024, false);
            JsonNode rows = payload.get("odometers");
            if (rows == null || !rows.isArray() || rows.isEmpty() || receivedAt == null) throw new IllegalArgumentException();
            List<Map<String, Object>> readings = new ArrayList<>();
            List<String> names = List.of("feet", "km", "metres", "miles");
            List<BigDecimal> factors = List.of(new BigDecimal("0.0003048"), BigDecimal.ONE, new BigDecimal("0.001"), new BigDecimal("1.609344"));
            for (JsonNode row : rows) {
                String day = text(row.get("date"), 8, false), timestamp = text(row.get("timestamp"), 14, false);
                if (!day.matches("[0-9]{8}") || !timestamp.matches("[0-9]{14}")) throw new IllegalArgumentException();
                LocalDate.parse(day, DateTimeFormatter.BASIC_ISO_DATE);
                LocalDateTime observed = LocalDateTime.parse(timestamp, DateTimeFormatter.ofPattern("uuuuMMddHHmmss").withResolverStyle(ResolverStyle.STRICT));
                double value = number(row.get("value"), false); long unit = integer(row.get("unit"));
                if (value < 0 || unit > 3) throw new IllegalArgumentException();
                BigDecimal decimal = row.get("value").decimalValue(); double km = decimal.multiply(factors.get((int) unit)).doubleValue();
                if (!Double.isFinite(km)) throw new IllegalArgumentException();
                readings.add(map("value", decimal.toPlainString(), "unit_code", unit, "unit", names.get((int) unit), "value_km", km,
                    "query_date_raw", day, "provider_timestamp_raw", timestamp, "provider_observed_at_local", observed.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME), "provider_timezone", null));
            }
            Map<String, Object> latest = readings.stream().max(Comparator.comparing(row -> (String) row.get("provider_timestamp_raw"))).orElseThrow();
            return map("odometer_km", latest.get("value_km"), "odometer_readings", readings, "observed_at", null,
                "provider_timestamp_raw", latest.get("provider_timestamp_raw"), "provider_timezone", null, "received_at", receivedAt.toString(), "odometer_policy", "absolute_provider_reading_do_not_add_trip_distance");
        } catch (IllegalArgumentException | DateTimeException | NullPointerException error) { throw malformed(); }
    }
    public Map<String, Object> vehicleStatus(String powertrain) {
        if (!Set.of("ICE", "HYB", "EV", "HYBRID", "PHEV").contains(powertrain)) throw new IllegalArgumentException("Unsupported powertrain");
        enabled(settings.mode());
        if (!settings.mode().equals("mock")) throw new ProviderException("provider_not_configured", "현대 실차 연결은 차량 인증·동의와 데이터 계약 확인 후 사용할 수 있습니다.", 503);
        Map<String, Object> result = metadata("hyundai", settings.mode(), false);
        result.putAll(normalizeOdometer(mapper.valueToTree(map("msgId", "synthetic-drivemate-status", "odometers", List.of(map("date", "20261028", "timestamp", "20261028090000", "value", 12500, "unit", 1)))), Instant.now()));
        boolean electric = Set.of("EV", "PHEV").contains(powertrain); int range = electric ? 280 : 420;
        Map<String, Object> warnings = new LinkedHashMap<>();
        for (String warning : List.of("engine_oil", "tire_pressure", "brake_oil", "low_fuel", "washer_fluid", "smart_key_battery")) warnings.put(warning, false);
        result.putAll(map("range_km", range, "range_raw", map("value", range, "unit_code", 1, "unit", "km", "provider_timestamp_raw", "20261028090000", "provider_timezone", null),
            "battery_percent", electric ? 72 : null, "warnings", warnings, "warnings_observed_at", null, "freshness", "unknown", "vehicle_id", "mock-vehicle",
            "notice", "직접 만든 예시 차량 상태입니다. 실차 정보가 아니며 누적 주행거리에 자동 합산하지 않습니다."));
        return result;
    }
}
