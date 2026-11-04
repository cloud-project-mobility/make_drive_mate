package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

@Component
public class SnapshotValidator {
    private static final Pattern TIMESTAMP = Pattern.compile("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})");
    private static final Set<String> OPTIONAL_NON_NULL = Set.of("origin", "destination", "eventTitle", "eventAt",
            "distanceKm", "note", "originPoint", "destinationPoint", "route", "planId", "catalogId");

    public long validateUpload(JsonNode upload) {
        fields(upload, Set.of("expected_revision", "state"), Set.of());
        JsonNode expected = upload.get("expected_revision");
        if (!expected.isIntegralNumber() || !expected.canConvertToLong() || expected.longValue() < 0) fail();
        validate(upload.get("state"));
        return expected.longValue();
    }

    public void validate(JsonNode state) {
        fields(state, Set.of("version", "vehicles", "selectedVehicleId", "trips", "plans", "maintenance",
                "activeTrip", "settings", "onboarded", "demoMode"), Set.of());
        visitText(state, "");
        if (!state.get("version").isIntegralNumber() || state.get("version").intValue() != 1
                || !state.get("version").canConvertToInt()) fail();
        if (!state.get("onboarded").isBoolean() || !state.get("onboarded").booleanValue()
                || !state.get("demoMode").isBoolean() || !state.get("activeTrip").isNull()) fail();
        array(state.get("vehicles"), 3);
        array(state.get("trips"), 20_000);
        array(state.get("plans"), 2_000);
        array(state.get("maintenance"), 20_000);
        fields(state.get("settings"), Set.of("walkMinutes", "bufferMinutes"), Set.of());
        number(state.get("settings"), "walkMinutes", 0, 180);
        number(state.get("settings"), "bufferMinutes", 0, 180);

        Map<String, JsonNode> vehicles = new HashMap<>();
        for (JsonNode vehicle : state.get("vehicles")) {
            fields(vehicle, Set.of("id", "name", "model", "powertrain", "odometerKm", "createdAt"), Set.of("catalogId"));
            String id = text(vehicle, "id", 100);
            text(vehicle, "name", 60);
            text(vehicle, "model", 100);
            if (vehicle.has("catalogId") && !text(vehicle, "catalogId", 80).matches("[a-z0-9-]{1,80}")) fail();
            choice(vehicle, "powertrain", Set.of("ICE", "HYB", "EV"));
            number(vehicle, "odometerKm", 0, 2_000_000);
            timestamp(vehicle, "createdAt");
            if (vehicles.put(id, vehicle) != null) fail();
        }
        JsonNode selected = state.get("selectedVehicleId");
        if (!selected.isNull()) {
            if (!selected.isTextual() || !vehicles.containsKey(selected.textValue())) fail();
        } else if (!vehicles.isEmpty()) fail();

        Set<String> tripIds = new HashSet<>();
        for (JsonNode trip : state.get("trips")) {
            fields(trip, Set.of("id", "vehicleId", "startedAt", "distanceKm", "durationSeconds", "endedAt", "source"),
                    Set.of("origin", "destination", "planId"));
            identity(trip, tripIds, vehicles);
            OffsetDateTime start = timestamp(trip, "startedAt");
            OffsetDateTime end = timestamp(trip, "endedAt");
            number(trip, "distanceKm", 0, 10_000);
            double duration = number(trip, "durationSeconds", 0, 604_800);
            double elapsed = (end.toInstant().toEpochMilli() - start.toInstant().toEpochMilli()) / 1000.0;
            if (elapsed < 0 || duration > elapsed + 2) fail();
            choice(trip, "source", Set.of("gps", "manual", "sample"));
            optionalText(trip, "origin", 160);
            optionalText(trip, "destination", 160);
            optionalText(trip, "planId", 100);
        }

        Set<String> planIds = new HashSet<>();
        for (JsonNode plan : state.get("plans")) {
            fields(plan, Set.of("id", "vehicleId", "origin", "destination", "driveMinutes", "walkMinutes",
                    "bufferMinutes", "source", "createdAt"), Set.of("eventTitle", "eventAt", "distanceKm",
                    "originPoint", "destinationPoint", "route"));
            identity(plan, planIds, vehicles);
            text(plan, "origin", 160);
            text(plan, "destination", 160);
            number(plan, "driveMinutes", 1, 1440);
            number(plan, "walkMinutes", 0, 180);
            number(plan, "bufferMinutes", 0, 180);
            choice(plan, "source", Set.of("manual", "sample"));
            timestamp(plan, "createdAt");
            optionalText(plan, "eventTitle", 100);
            if (plan.has("eventAt")) timestamp(plan, "eventAt");
            if (plan.has("distanceKm")) number(plan, "distanceKm", 0, 10_000);
            if (plan.has("originPoint")) coordinate(plan.get("originPoint"));
            if (plan.has("destinationPoint")) coordinate(plan.get("destinationPoint"));
            if (plan.has("route")) {
                if (!plan.has("originPoint") || !plan.has("destinationPoint") || !plan.has("distanceKm") || !plan.has("eventAt")) fail();
                JsonNode route = plan.get("route");
                fields(route, Set.of("source", "computedAt", "expiresAt"), Set.of());
                String source = choice(route, "source", Set.of("mock", "live"));
                OffsetDateTime computed = timestamp(route, "computedAt");
                OffsetDateTime expires = timestamp(route, "expiresAt");
                if (!expires.toInstant().isAfter(computed.toInstant())) fail();
                if (source.equals("mock") && !plan.get("source").textValue().equals("sample")) fail();
            }
        }

        Set<String> maintenanceIds = new HashSet<>();
        for (JsonNode record : state.get("maintenance")) {
            fields(record, Set.of("id", "vehicleId", "itemId", "odometerKm", "performedAt"), Set.of("note"));
            identity(record, maintenanceIds, vehicles);
            String item = text(record, "itemId", 100);
            JsonNode vehicle = vehicles.get(record.get("vehicleId").textValue());
            Set<String> items = new HashSet<>(Set.of("tires", "brakes", "cabin-filter", "wipers"));
            if (vehicle.get("powertrain").textValue().equals("EV")) items.add("cooling");
            else items.addAll(Set.of("engine-oil", "engine-air-filter"));
            if (!items.contains(item) || number(record, "odometerKm", 0, 2_000_000) > vehicle.get("odometerKm").doubleValue()) fail();
            timestamp(record, "performedAt");
            optionalText(record, "note", 500);
        }
    }

    private static void identity(JsonNode row, Set<String> ids, Map<String, JsonNode> vehicles) {
        if (!ids.add(text(row, "id", 100)) || !vehicles.containsKey(text(row, "vehicleId", 100))) fail();
    }

    private static void coordinate(JsonNode value) {
        fields(value, Set.of("longitude", "latitude"), Set.of());
        number(value, "longitude", -180, 180);
        number(value, "latitude", -90, 90);
    }

    public static void fields(JsonNode node, Set<String> required, Set<String> optional) {
        if (node == null || !node.isObject()) fail();
        for (String key : required) if (!node.has(key)) fail();
        node.fieldNames().forEachRemaining(key -> {
            if (!required.contains(key) && !optional.contains(key)) fail();
        });
    }

    public static String text(JsonNode node, String name, int maximum) {
        JsonNode value = node.get(name);
        if (value == null || !value.isTextual() || value.textValue().isBlank()
                || value.textValue().length() > maximum) fail();
        return value.textValue();
    }

    private static void optionalText(JsonNode node, String name, int maximum) {
        if (node.has(name)) text(node, name, maximum);
    }

    public static double number(JsonNode node, String name, double minimum, double maximum) {
        JsonNode value = node.get(name);
        if (value == null || !value.isNumber() || !Double.isFinite(value.doubleValue())
                || value.doubleValue() < minimum || value.doubleValue() > maximum) fail();
        return value.doubleValue();
    }

    private static void array(JsonNode node, int maximum) {
        if (node == null || !node.isArray() || node.size() > maximum) fail();
    }

    private static String choice(JsonNode node, String name, Set<String> choices) {
        String value = text(node, name, 100);
        if (!choices.contains(value)) fail();
        return value;
    }

    public static OffsetDateTime timestamp(JsonNode node, String name) {
        String value = text(node, name, 64);
        if (!TIMESTAMP.matcher(value).matches()) fail();
        try {
            return OffsetDateTime.parse(value);
        } catch (DateTimeParseException exception) {
            throw ApiException.invalid();
        }
    }

    private static void visitText(JsonNode node, String key) {
        if (node.isObject()) node.fields().forEachRemaining(entry -> visitText(entry.getValue(), entry.getKey()));
        else if (node.isArray()) node.forEach(item -> visitText(item, ""));
        else if (node.isTextual()) {
            String value = node.textValue();
            if (value.isBlank()) fail();
            for (int index = 0; index < value.length(); index++) {
                char character = value.charAt(index);
                if (character < 32 && !(key.equals("note") && (character == 9 || character == 10 || character == 13))) fail();
            }
        }
        if (OPTIONAL_NON_NULL.contains(key) && node.isNull()) fail();
    }

    private static void fail() { throw ApiException.invalid(); }
}
