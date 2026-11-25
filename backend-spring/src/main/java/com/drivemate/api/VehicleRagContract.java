package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import java.net.URI;
import java.time.Year;
import java.time.ZoneOffset;
import java.util.HashSet;
import java.util.Set;

/** User identity is input, never permission to choose a collection, URL or filesystem path. */
final class VehicleRagContract {
    private VehicleRagContract() { }
    private static final Set<String> HOSTS = Set.of("ownersmanual.hyundai.com", "ownersmanual.kia.com");

    static void identity(JsonNode identity) {
        if (identity == null || identity.isNull()) return;
        SnapshotValidator.fields(identity, Set.of("make", "model", "model_year", "fuel"), Set.of());
        for (String field : Set.of("make", "model", "fuel")) {
            if (!identity.get(field).isNull()) {
                String value = SnapshotValidator.text(identity, field, 100);
                if (value.chars().anyMatch(c -> c < 32)) throw ApiException.invalid();
            }
        }
        if (!identity.get("model_year").isNull()) integer(identity, "model_year", 1970, Year.now(ZoneOffset.UTC).getValue() + 1);
    }

    private static void integer(JsonNode node, String field, int minimum, int maximum) {
        JsonNode value = node.get(field);
        if (!value.isIntegralNumber() || !value.canConvertToInt() || value.intValue() < minimum || value.intValue() > maximum) throw ApiException.invalid();
    }

    static void response(JsonNode result) {
        try {
            SnapshotValidator.fields(result, Set.of("scope", "status", "sources", "answer_source_ids", "method"), Set.of());
            if (!"public_vehicle".equals(result.path("scope").asText()) || !Set.of("disabled", "unavailable", "needs_vehicle_details", "no_match", "not_used", "matched").contains(result.path("status").asText())) throw ApiException.invalid();
            if (!result.get("method").isNull() && !Set.of("bm25+pgvector-cosine-rrf", "bm25+local-cosine-rrf").contains(result.get("method").asText())) throw ApiException.invalid();
            JsonNode sources = result.get("sources"), ids = result.get("answer_source_ids");
            if (!sources.isArray() || !ids.isArray() || sources.size() > 3 || ids.size() != sources.size() || ("matched".equals(result.path("status").asText()) != !sources.isEmpty())) throw ApiException.invalid();
            Set<String> seen = new HashSet<>();
            for (int i = 0; i < sources.size(); i++) {
                JsonNode source = sources.get(i);
                SnapshotValidator.fields(source, Set.of("source_id", "document_title", "source_uri", "section", "page", "excerpt", "applicability", "source_kind"), Set.of());
                String id = SnapshotValidator.text(source, "source_id", 100);
                if (!id.matches("[A-Za-z0-9_.:-]{1,100}") || !seen.add(id) || !ids.get(i).isTextual() || !id.equals(ids.get(i).asText()) || !"official_manual_summary".equals(source.path("source_kind").asText())) throw ApiException.invalid();
                SnapshotValidator.text(source, "document_title", 200);
                SnapshotValidator.text(source, "section", 200);
                SnapshotValidator.text(source, "excerpt", 1600);
                URI uri = URI.create(SnapshotValidator.text(source, "source_uri", 2000));
                if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || !HOSTS.contains(uri.getHost().toLowerCase(java.util.Locale.ROOT)) || uri.getUserInfo() != null || (uri.getPort() != -1 && uri.getPort() != 443)) throw ApiException.invalid();
                if (!source.get("page").isNull()) integer(source, "page", 1, 10000);
                JsonNode applicability = source.get("applicability");
                SnapshotValidator.fields(applicability, Set.of("scope", "make", "model", "year_from", "year_to", "fuel_types"), Set.of());
                JsonNode fuels = applicability.get("fuel_types");
                if (!fuels.isArray() || fuels.size() > 20) throw ApiException.invalid();
                Set<String> fuelSet = new HashSet<>();
                for (JsonNode fuel : fuels) if (!fuel.isTextual() || fuel.asText().isBlank() || fuel.asText().length() > 100 || !fuelSet.add(fuel.asText())) throw ApiException.invalid();
                if ("general".equals(applicability.path("scope").asText())) {
                    for (String field : Set.of("make", "model", "year_from", "year_to")) if (!applicability.get(field).isNull()) throw ApiException.invalid();
                    if (!fuels.isEmpty()) throw ApiException.invalid();
                } else if ("model_specific".equals(applicability.path("scope").asText())) {
                    SnapshotValidator.text(applicability, "make", 100);
                    SnapshotValidator.text(applicability, "model", 100);
                    integer(applicability, "year_from", 1970, 2100);
                    if (!applicability.get("year_to").isNull()) integer(applicability, "year_to", applicability.get("year_from").intValue(), 2100);
                } else throw ApiException.invalid();
            }
        } catch (RuntimeException invalid) {
            throw new ApiException("assistant_failed", "공개 차량 문서의 출처를 검증하지 못했어요.", 502);
        }
    }
}
