package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class AssistantService implements AutoCloseable {
    private final JsonWorkerProcess runner;
    private final String python;
    private final String worker;
    private final String model;
    private final boolean enabled;

    public AssistantService(ObjectMapper json,
            @Value("${DRIVEMATE_PYTHON:python3}") String python,
            @Value("${DRIVEMATE_ML_WORKER:../backend/scripts/onbid_worker.py}") String modelWorker,
            @Value("${DRIVEMATE_MODEL_BUNDLE:}") String model,
            @Value("${DRIVEMATE_ALLOW_LLM:false}") boolean enabled) {
        this.runner = new JsonWorkerProcess(json);
        this.python = python;
        this.worker = Path.of(modelWorker).resolveSibling("assistant_worker.py").toString();
        this.model = model;
        this.enabled = enabled;
    }

    void requireEnabled() {
        if (!enabled) throw new ApiException("llm_disabled", "이 서버에서는 AI 상담을 아직 사용 설정하지 않았어요.", 503);
    }

    public JsonNode query(JsonNode request) {
        validate(request);
        requireEnabled();
        List<String> command = new ArrayList<>(List.of(python, worker, "--allow-llm"));
        if (request.has("analysis")) {
            if (model.isBlank()) throw new ApiException("model_unavailable", "검증된 가격 모델이 아직 연결되지 않았어요.", 503);
            command.addAll(List.of("--model-bundle", model));
        }
        JsonWorkerProcess.Result output = runner.run(command, request, 120, this::start, "assistant");
        JsonNode result = output.body();
        if (output.exitCode() != 0 || !result.path("ok").asBoolean(false)) {
            String code = result.path("error").path("code").asText();
            if (Set.of("INVALID_INPUT", "INVALID_JSON", "REQUEST_TOO_LARGE").contains(code)) throw ApiException.invalid();
            if (code.equals("LLM_NOT_CONFIGURED")) throw new ApiException("llm_not_configured", "AI 연결 설정을 확인해 주세요.", 503);
            if (code.equals("MODEL_UNAVAILABLE")) throw new ApiException("model_unavailable", "검증된 가격 모델을 사용할 수 없어요.", 503);
            throw new ApiException("assistant_failed", "AI 상담을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.", 502);
        }
        if (!"assistant-v1".equals(result.path("api_version").asText()) || !result.path("answer").isTextual()
                || !result.path("facts").isArray() || !result.path("price_generation_by_llm").isBoolean()
                || result.path("price_generation_by_llm").booleanValue()) {
            throw new ApiException("assistant_failed", "AI 응답의 근거를 확인하지 못했어요.", 502);
        }
        return result;
    }

    Process start(List<String> command) throws IOException {
        ProcessBuilder builder = new ProcessBuilder(command).redirectError(ProcessBuilder.Redirect.DISCARD);
        builder.environment().keySet().retainAll(Set.of("PATH", "HOME", "LANG", "LC_ALL", "LD_LIBRARY_PATH",
                "SYSTEMROOT", "TMPDIR", "TMP", "TEMP", "OPENAI_API_KEY", "OPENAI_MODEL", "DRIVEMATE_MODEL_SHA256"));
        builder.environment().put("PYTHONUTF8", "1");
        for (String key : List.of("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS")) builder.environment().put(key, "2");
        return builder.start();
    }

    static void validate(JsonNode request) {
        SnapshotValidator.fields(request, Set.of("question", "context"), Set.of("previous_question", "analysis"));
        if (request.toString().getBytes(StandardCharsets.UTF_8).length > 32768) throw ApiException.invalid();
        SnapshotValidator.text(request, "question", 1000);
        if (request.has("previous_question")) SnapshotValidator.text(request, "previous_question", 1000);
        JsonNode context = request.get("context");
        SnapshotValidator.fields(context, Set.of("demo", "vehicle", "maintenance", "next_plan"), Set.of());
        if (!context.get("demo").isBoolean()) throw ApiException.invalid();
        JsonNode vehicle = context.get("vehicle");
        if (!vehicle.isNull()) {
            SnapshotValidator.fields(vehicle, Set.of("powertrain", "odometer_km"), Set.of());
            if (!Set.of("ICE", "HYB", "EV").contains(vehicle.path("powertrain").asText())) throw ApiException.invalid();
            SnapshotValidator.number(vehicle, "odometer_km", 0, 2_000_000);
        }
        JsonNode records = context.get("maintenance");
        if (!records.isArray() || records.size() > 7) throw ApiException.invalid();
        Set<String> items = new HashSet<>();
        for (JsonNode record : records) {
            SnapshotValidator.fields(record, Set.of("item", "status", "recorded"), Set.of());
            String item = record.path("item").asText();
            if (!Set.of("tires", "brakes", "cabin-filter", "wipers", "engine-oil", "engine-air-filter", "cooling").contains(item)
                    || !items.add(item) || !Set.of("unrecorded", "ok", "dueSoon", "overdue", "manual").contains(record.path("status").asText())
                    || !record.get("recorded").isBoolean()) throw ApiException.invalid();
        }
        JsonNode plan = context.get("next_plan");
        if (!plan.isNull()) {
            SnapshotValidator.fields(plan, Set.of("event_at", "departure_at", "route_fresh", "sample"), Set.of());
            instant(plan, "event_at");
            if (!plan.get("departure_at").isNull()) instant(plan, "departure_at");
            if (!plan.get("route_fresh").isBoolean() || !plan.get("sample").isBoolean()) throw ApiException.invalid();
        }
        if (request.has("analysis")) {
            if (request.get("analysis").has("use_llm")) throw ApiException.invalid();
            ValuationService.validate(request.get("analysis"));
        }
    }

    private static void instant(JsonNode plan, String key) {
        String value = SnapshotValidator.text(plan, key, 32);
        if (!value.matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z")) throw ApiException.invalid();
        try { Instant.parse(value); } catch (Exception ignored) { throw ApiException.invalid(); }
    }

    @PreDestroy @Override public void close() { runner.close(); }
}
