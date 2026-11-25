package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

class VehicleRagTest {
    private final ObjectMapper json = new ObjectMapper();

    private ObjectNode response() throws Exception {
        return (ObjectNode) json.readTree("""
                {"scope":"public_vehicle","status":"matched","method":"bm25+pgvector-cosine-rrf",
                "answer_source_ids":["manual-tires"],"sources":[{"source_id":"manual-tires",
                "document_title":"공식 설명서 기반 요약","source_uri":"https://ownersmanual.hyundai.com/manual.pdf#page=12",
                "section":"타이어 점검","page":12,"excerpt":"타이어 상태를 확인하세요.",
                "source_kind":"official_manual_summary","applicability":{"scope":"model_specific",
                "make":"현대","model":"아반떼","year_from":2023,"year_to":2023,"fuel_types":["휘발유"]}}]}
                """);
    }

    @Test void identitiesAreOptionalAndNeverChoosePrivateCollectionOrUrl() throws Exception {
        assertDoesNotThrow(() -> VehicleRagContract.identity(null));
        assertDoesNotThrow(() -> VehicleRagContract.identity(json.readTree("{\"make\":null,\"model\":null,\"model_year\":null,\"fuel\":null}")));
        for (String value : List.of(
                "{\"make\":\"현대\",\"model\":\"아반떼\",\"model_year\":true,\"fuel\":null}",
                "{\"make\":\"현대\",\"model\":\"아반떼\",\"model_year\":2023.0,\"fuel\":null}",
                "{\"make\":\"현대\",\"model\":\"아반떼\",\"model_year\":2023,\"fuel\":null,\"collection_id\":\"private\"}")) {
            assertThrows(ApiException.class, () -> VehicleRagContract.identity(json.readTree(value)));
        }
    }

    @Test void sourceIdsScopeAndOfficialProvenanceAreEnforced() throws Exception {
        assertDoesNotThrow(() -> VehicleRagContract.response(response()));
        for (String url : List.of("http://ownersmanual.hyundai.com/manual", "https://ownersmanual.hyundai.com.evil.test/",
                "https://user@ownersmanual.kia.com/", "https://ownersmanual.kia.com:8443/")) {
            var value = response();
            ((ObjectNode) value.get("sources").get(0)).put("source_uri", url);
            assertThat(assertThrows(ApiException.class, () -> VehicleRagContract.response(value)).status()).isEqualTo(502);
        }
        var privateScope = response().put("scope", "private_project");
        assertThrows(ApiException.class, () -> VehicleRagContract.response(privateScope));
        var unknownId = response();
        unknownId.putArray("answer_source_ids").add("invented");
        assertThrows(ApiException.class, () -> VehicleRagContract.response(unknownId));
        var nonMatched = response().put("status", "no_match");
        assertThrows(ApiException.class, () -> VehicleRagContract.response(nonMatched));
    }

    @Test void sourceSummariesCannotClaimUnvalidatedPageOrApplicability() throws Exception {
        for (String field : List.of("page", "source_kind", "applicability")) {
            var value = response();
            ObjectNode source = (ObjectNode) value.get("sources").get(0);
            if (field.equals("page")) source.put(field, 0);
            if (field.equals("source_kind")) source.put(field, "verbatim_quote");
            if (field.equals("applicability")) ((ObjectNode) source.get(field)).put("scope", "general");
            assertThrows(ApiException.class, () -> VehicleRagContract.response(value));
        }
    }

    @Test void workerGetsOnlyServerFixedCollectionArgumentsAndValidatedIdentity() throws Exception {
        JsonNode request = json.readTree("""
                {"question":"타이어 점검은 어떻게 하나요?","context":{"demo":false,"vehicle":null,"maintenance":[],"next_plan":null},
                "vehicle_identity":{"make":"현대","model":"아반떼","model_year":2023,"fuel":"휘발유"}}
                """);
        var body = json.createObjectNode().put("ok", true).put("api_version", "assistant-v1")
                .put("answer", "근거 요약을 살펴보세요.").put("price_generation_by_llm", false);
        body.putArray("facts");
        body.set("vehicle_rag", response());
        ByteArrayOutputStream stdin = new ByteArrayOutputStream();
        try (var service = new AssistantService(json, "fixed-python", "fixed/onbid_worker.py", "", true,
                true, "/fixed/public.json", "a".repeat(64), "pgvector") {
            @Override Process start(List<String> command) {
                assertThat(command).containsExactly("fixed-python", "fixed/assistant_worker.py", "--allow-llm",
                        "--vehicle-rag-enabled", "--vehicle-collection", "/fixed/public.json",
                        "--vehicle-collection-sha256", "a".repeat(64), "--vehicle-rag-backend", "pgvector");
                return new Process() {
                    public OutputStream getOutputStream() { return stdin; }
                    public InputStream getInputStream() { return new ByteArrayInputStream(body.toString().getBytes(StandardCharsets.UTF_8)); }
                    public InputStream getErrorStream() { return InputStream.nullInputStream(); }
                    public int waitFor() { return 0; }
                    public boolean waitFor(long timeout, TimeUnit unit) { return true; }
                    public int exitValue() { return 0; }
                    public void destroy() { }
                    public Process destroyForcibly() { return this; }
                };
            }
        }) {
            assertThat(service.query(request).path("vehicle_rag").path("status").asText()).isEqualTo("matched");
            assertThat(json.readTree(stdin.toByteArray())).isEqualTo(request);
        }
    }
}
