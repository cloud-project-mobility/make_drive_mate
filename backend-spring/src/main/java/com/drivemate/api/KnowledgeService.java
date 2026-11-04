package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class KnowledgeService {
    private final JsonWorkerProcess runner;
    private final String python;
    private final String worker;
    private final String collection;
    private final boolean allowLlm;
    private final String backend;

    public KnowledgeService(ObjectMapper json,
            @Value("${DRIVEMATE_PYTHON:python3}") String python,
            @Value("${DRIVEMATE_RAG_WORKER:../backend/scripts/document_rag.py}") String worker,
            @Value("${DRIVEMATE_RAG_COLLECTION:}") String collection,
            @Value("${DRIVEMATE_ALLOW_LLM:false}") boolean allowLlm,
            @Value("${DRIVEMATE_RAG_BACKEND:pgvector}") String backend) {
        if (!Set.of("pgvector", "local").contains(backend)) throw new IllegalArgumentException("Unsupported RAG backend");
        this.runner = new JsonWorkerProcess(json);
        this.python = python;
        this.worker = worker;
        this.collection = collection;
        this.allowLlm = allowLlm;
        this.backend = backend;
    }

    static void validate(JsonNode request) {
        SnapshotValidator.fields(request, Set.of("question"), Set.of("use_llm"));
        String question = SnapshotValidator.text(request, "question", 1000);
        if (question.chars().anyMatch(character -> character < 32)) throw ApiException.invalid();
        if (request.has("use_llm") && !request.get("use_llm").isBoolean()) throw ApiException.invalid();
    }

    public JsonNode query(JsonNode request) {
        validate(request);
        if (collection.isBlank() || worker.isBlank() || python.isBlank()) {
            throw new ApiException("knowledge_unavailable", "검증된 문서 검색 자료가 아직 연결되지 않았어요.", 503);
        }
        boolean useLlm = request.path("use_llm").asBoolean(false);
        if (useLlm && !allowLlm) throw new ApiException("llm_disabled", "이 서버에서는 GPT 문서 정리를 아직 사용 설정하지 않았어요.", 503);
        List<String> command = new ArrayList<>(List.of(python, worker, "query", "--backend", backend, "--collection-file", collection));
        if (useLlm) command.add("--allow-llm");
        JsonWorkerProcess.Result output = runner.run(command, request, 115, this::start, "knowledge");
        JsonNode response = output.body();
        if (output.exitCode() != 0 || !response.path("ok").asBoolean(false)) {
            String code = response.path("error").path("code").asText();
            if (Set.of("INVALID_INPUT", "INVALID_JSON", "REQUEST_TOO_LARGE").contains(code)) throw ApiException.invalid();
            throw new ApiException("knowledge_unavailable", "문서 검색 연결을 사용할 수 없어요. 잠시 후 다시 시도해 주세요.", 503);
        }
        JsonNode result = response.path("result");
        if (!"document-rag-v1".equals(response.path("api_version").asText()) || !result.isObject()
                || !Set.of("answered", "retrieval_only", "abstained").contains(result.path("status").asText())
                || !result.path("sources").isArray() || !result.path("answer_source_ids").isArray()) {
            throw new ApiException("knowledge_failed", "검증 가능한 문서 검색 결과를 받지 못했어요.", 502);
        }
        return response;
    }

    Process start(List<String> command) throws IOException {
        ProcessBuilder builder = new ProcessBuilder(command).redirectError(ProcessBuilder.Redirect.DISCARD);
        builder.environment().keySet().retainAll(Set.of("PATH", "HOME", "LANG", "LC_ALL", "LD_LIBRARY_PATH",
                "SYSTEMROOT", "TMPDIR", "TMP", "TEMP", "OPENAI_API_KEY", "OPENAI_MODEL",
                "OPENAI_EMBEDDING_MODEL", "DRIVEMATE_PG_HOST", "DRIVEMATE_PG_PORT", "DRIVEMATE_PG_DATABASE",
                "DRIVEMATE_PG_USER", "DRIVEMATE_PG_PASSWORD", "DRIVEMATE_PG_SSLROOTCERT"));
        builder.environment().put("PYTHONUTF8", "1");
        builder.environment().put("OMP_NUM_THREADS", "2");
        builder.environment().put("OPENBLAS_NUM_THREADS", "2");
        return builder.start();
    }

    @PreDestroy public void close() { runner.close(); }
}
