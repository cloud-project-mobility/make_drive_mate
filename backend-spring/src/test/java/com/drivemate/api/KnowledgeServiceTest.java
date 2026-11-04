package com.drivemate.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;

class KnowledgeServiceTest {
    private final ObjectMapper json = new ObjectMapper();

    @Test void unconfiguredCollectionAndUnsupportedFieldsFailSafely() throws Exception {
        KnowledgeService service = new KnowledgeService(json, "python3", "worker.py", "", false, "pgvector");
        try {
            var request = json.readTree("{\"question\":\"데이터 한계\"}");
            assertThat(assertThrows(ApiException.class, () -> service.query(request)).code()).isEqualTo("knowledge_unavailable");
            var unsupported = json.readTree("{\"question\":\"자료\",\"scope\":\"/private/file\"}");
            assertThat(assertThrows(ApiException.class, () -> service.query(unsupported)).status()).isEqualTo(422);
            var longQuestion = json.createObjectNode().put("question", "가".repeat(1001));
            assertThrows(ApiException.class, () -> service.query(longQuestion));
        } finally { service.close(); }
    }

    @Test void verifiedSourceResultsKeepStatusAndFixedCollectionArguments() throws Exception {
        String response = """
                {"ok":true,"api_version":"document-rag-v1","result":{"status":"retrieval_only",
                "answer_mode":"verified_excerpts","sources":[{"source_id":"plan-1","status":"planned",
                "quote":"향후 검증할 계획입니다."}],"answer_source_ids":["plan-1"]}}
                """;
        for (String backend : List.of("pgvector", "local")) {
        KnowledgeService service = new KnowledgeService(json, "fixed-python", "fixed-rag.py", "fixed-collection.json", false, backend) {
            @Override Process start(List<String> command) {
                assertThat(command).containsExactly("fixed-python", "fixed-rag.py", "query", "--backend", backend,
                        "--collection-file", "fixed-collection.json");
                return new Process() {
                    @Override public OutputStream getOutputStream() { return new ByteArrayOutputStream(); }
                    @Override public InputStream getInputStream() { return new ByteArrayInputStream(response.getBytes(StandardCharsets.UTF_8)); }
                    @Override public InputStream getErrorStream() { return InputStream.nullInputStream(); }
                    @Override public int waitFor() { return 0; }
                    @Override public boolean waitFor(long timeout, TimeUnit unit) { return true; }
                    @Override public int exitValue() { return 0; }
                    @Override public void destroy() { }
                };
            }
        };
        try {
            var result = service.query(json.readTree("{\"question\":\"문서의 계획은?\",\"use_llm\":false}"));
            assertThat(result.path("result").path("sources").get(0).path("status").asText()).isEqualTo("planned");
            var paid = json.readTree("{\"question\":\"문서\",\"use_llm\":true}");
            assertThat(assertThrows(ApiException.class, () -> service.query(paid)).code()).isEqualTo("llm_disabled");
        } finally { service.close(); }
        }
    }

    @Test void invalidBackendCannotChangeWorkerArguments() {
        assertThrows(IllegalArgumentException.class,
                () -> new KnowledgeService(json, "python3", "worker.py", "collection.json", false, "local --other"));
    }
}
