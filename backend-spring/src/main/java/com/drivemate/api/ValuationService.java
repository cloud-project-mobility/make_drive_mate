package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class ValuationService {
    static final int MAX_OUTPUT_BYTES = JsonWorkerProcess.MAX_OUTPUT_BYTES;
    private final JsonWorkerProcess runner;
    private final String python;
    private final String worker;
    private final String model;
    private final boolean allowLlm;
    private final int timeoutSeconds;

    public ValuationService(ObjectMapper json,
            @Value("${DRIVEMATE_PYTHON:python3}") String python,
            @Value("${DRIVEMATE_ML_WORKER:../backend/scripts/onbid_worker.py}") String worker,
            @Value("${DRIVEMATE_MODEL_BUNDLE:}") String model,
            @Value("${DRIVEMATE_ALLOW_LLM:false}") boolean allowLlm,
            @Value("${DRIVEMATE_PREDICTION_TIMEOUT_SECONDS:120}") int timeoutSeconds) {
        if (timeoutSeconds < 1 || timeoutSeconds > 120) throw new IllegalArgumentException("Prediction timeout must be 1..120 seconds");
        this.runner = new JsonWorkerProcess(json);
        this.python = python;
        this.worker = worker;
        this.model = model;
        this.allowLlm = allowLlm;
        this.timeoutSeconds = timeoutSeconds;
    }

    public JsonNode simulate(JsonNode request) {
        validate(request);
        boolean useLlm = request.path("use_llm").asBoolean(false);
        if (useLlm && !allowLlm) {
            throw new ApiException("llm_disabled", "이 서버에서는 GPT 설명을 아직 사용 설정하지 않았어요.", 503);
        }
        if (model.isBlank() || worker.isBlank() || python.isBlank()) {
            throw new ApiException("model_unavailable", "검증된 가격 모델이 아직 연결되지 않았어요.", 503);
        }
        try {
            List<String> command = new ArrayList<>(List.of(python, worker, "--model-bundle", model));
            if (useLlm) command.add("--allow-llm");
            JsonWorkerProcess.Result response = runner.run(command, request, timeoutSeconds, this::start, "prediction");
            JsonNode result = response.body();
            if (result == null || !result.isObject() || !result.path("ok").isBoolean()) throw new IOException("Invalid worker response");
            if (response.exitCode() != 0 || !result.get("ok").booleanValue()) {
                String code = result.path("error").path("code").asText();
                if (response.exitCode() == 2 && Set.of("INVALID_INPUT", "INVALID_JSON", "REQUEST_TOO_LARGE").contains(code)) {
                    throw ApiException.invalid();
                }
                if (code.equals("MODEL_UNAVAILABLE")) {
                    throw new ApiException("model_unavailable", "검증된 가격 모델을 사용할 수 없어요.", 503);
                }
                if (code.equals("LLM_NOT_CONFIGURED")) {
                    throw new ApiException("llm_not_configured", "GPT 연결 설정을 확인해 주세요.", 503);
                }
                throw new IOException("Worker failed");
            }
            if (!result.path("evidence").isObject() || !result.path("explanation").isObject()
                    || !"onbid-worker-v1".equals(result.path("api_version").asText())) {
                throw new IOException("Invalid worker contract");
            }
            return result;
        } catch (ApiException exception) {
            throw exception;
        } catch (Exception exception) {
            // Never return stderr, commands, local paths or credentials.
            throw new ApiException("prediction_failed", "가격 분석을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.", 502);
        }
    }

    Process start(List<String> command) throws IOException {
        ProcessBuilder builder = new ProcessBuilder(command).redirectError(ProcessBuilder.Redirect.DISCARD);
        // The model worker needs its own API key, never database or cloud management credentials.
        builder.environment().keySet().retainAll(Set.of("PATH", "HOME", "LANG", "LC_ALL", "LD_LIBRARY_PATH",
                "SYSTEMROOT", "TMPDIR", "TMP", "TEMP", "OPENAI_API_KEY", "OPENAI_MODEL", "DRIVEMATE_MODEL_SHA256"));
        builder.environment().put("PYTHONUTF8", "1");
        builder.environment().put("OMP_NUM_THREADS", "2");
        builder.environment().put("OPENBLAS_NUM_THREADS", "2");
        builder.environment().put("MKL_NUM_THREADS", "2");
        return builder.start();
    }

    static void validate(JsonNode request) {
        SnapshotValidator.fields(request, Set.of("vehicle"), Set.of("monthly_km", "months", "monthly_upkeep_krw", "use_llm"));
        if (request.toString().getBytes(StandardCharsets.UTF_8).length > 32768) throw ApiException.invalid();
        JsonNode vehicle = request.get("vehicle");
        SnapshotValidator.fields(vehicle, Set.of("model", "age_years", "odometer_km"),
                Set.of("make", "fuel", "vehicle_category", "engine_cc"));
        for (String field : List.of("make", "model", "fuel", "vehicle_category")) {
            if (!vehicle.hasNonNull(field) && !field.equals("model")) continue;
            String text = SnapshotValidator.text(vehicle, field, 100);
            if (text.chars().anyMatch(character -> character < 32)) throw ApiException.invalid();
        }
        SnapshotValidator.number(vehicle, "age_years", 0, 100);
        SnapshotValidator.number(vehicle, "odometer_km", 0, 2_000_000);
        if (vehicle.hasNonNull("engine_cc")) SnapshotValidator.number(vehicle, "engine_cc", 0, 30_000);
        if (request.has("monthly_km")) SnapshotValidator.number(request, "monthly_km", 0, 100_000);
        if (request.has("monthly_upkeep_krw")) SnapshotValidator.number(request, "monthly_upkeep_krw", 0, 100_000_000);
        if (request.has("use_llm") && !request.get("use_llm").isBoolean()) throw ApiException.invalid();
        if (request.has("months")) {
            JsonNode months = request.get("months");
            if (!months.isArray() || months.isEmpty() || months.size() > 25) throw ApiException.invalid();
            Set<Integer> unique = new HashSet<>();
            for (JsonNode month : months) {
                if (!month.isIntegralNumber() || !month.canConvertToInt() || month.intValue() < 0
                        || month.intValue() > 24 || !unique.add(month.intValue())) throw ApiException.invalid();
            }
        }
    }

    @PreDestroy
    public void close() {
        runner.close();
    }
}
