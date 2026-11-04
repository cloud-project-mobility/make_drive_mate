package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ValuationServiceTest {
    private final ObjectMapper json = new ObjectMapper();
    private static final String SUCCESS = """
            {"ok":true,"api_version":"onbid-worker-v1","evidence":{"price_kind":"auction_award"},
             "explanation":{"mode":"template","text":"공매 낙찰가 분석"}}
            """;

    private JsonNode request() throws Exception {
        return json.readTree("""
                {"vehicle":{"make":"현대","model":"쏘나타","fuel":"휘발유","vehicle_category":"승용차",
                "age_years":7,"odometer_km":151158,"engine_cc":1999},"months":[0,6,12],"use_llm":false}
                """);
    }

    private FakeService service(FakeProcess process, boolean allowLlm) {
        return new FakeService(process, allowLlm);
    }

    @Test void fixedArgumentsAndStructuredOutputAreUsed() throws Exception {
        FakeProcess process = new FakeProcess(SUCCESS, 0, true);
        try (FakeService service = service(process, false)) {
            JsonNode result = service.simulate(request());
            assertThat(result.path("evidence").path("price_kind").asText()).isEqualTo("auction_award");
            assertThat(service.command).containsExactly("fixed-python", "fixed-worker.py", "--model-bundle", "fixed-model.joblib");
            assertThat(json.readTree(process.stdin.toByteArray())).isEqualTo(request());
            assertThat(process.destroyed).isTrue();
        }
    }

    @Test void invalidInputAndClientPathsAreRejectedBeforeProcessStarts() throws Exception {
        try (FakeService service = service(new FakeProcess(SUCCESS, 0, true), true)) {
            JsonNode invalid = json.readTree("{\"vehicle\":{\"model\":\"아반떼\",\"age_years\":true,\"odometer_km\":1}}");
            assertThat(assertThrows(ApiException.class, () -> service.simulate(invalid)).status()).isEqualTo(422);
            var pathRequest = request().deepCopy();
            ((com.fasterxml.jackson.databind.node.ObjectNode) pathRequest).put("model_bundle", "/etc/private");
            assertThrows(ApiException.class, () -> service.simulate(pathRequest));
            assertThat(service.command).isNull();
        }
    }

    @Test void paidLlmRequiresServerOptInAndAddsOnlyFixedFlag() throws Exception {
        var llm = request().deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode) llm).put("use_llm", true);
        try (FakeService disabled = service(new FakeProcess(SUCCESS, 0, true), false)) {
            assertThat(assertThrows(ApiException.class, () -> disabled.simulate(llm)).code()).isEqualTo("llm_disabled");
            assertThat(disabled.command).isNull();
        }
        try (FakeService enabled = service(new FakeProcess(SUCCESS, 0, true), true)) {
            enabled.simulate(llm);
            assertThat(enabled.command).contains("--allow-llm");
        }
    }

    @Test void malformedOutputAndInternalErrorsStayPrivate() throws Exception {
        for (String stdout : List.of("secret-provider-token", "{\"ok\":false,\"error\":{\"code\":\"WORKER_FAILED\",\"message\":\"secret-provider-token\"}}")) {
            try (FakeService service = service(new FakeProcess(stdout, 3, true), false)) {
                ApiException error = assertThrows(ApiException.class, () -> service.simulate(request()));
                assertThat(error.code()).isEqualTo("prediction_failed");
                assertThat(error.getMessage()).doesNotContain("secret-provider-token", "fixed-model");
            }
        }
    }

    @Test void timeoutAndExcessOutputTerminateWorker() throws Exception {
        FakeProcess timeout = new FakeProcess(SUCCESS, 0, false);
        try (FakeService service = service(timeout, false)) {
            assertThat(assertThrows(ApiException.class, () -> service.simulate(request())).status()).isEqualTo(504);
            assertThat(timeout.destroyed).isTrue();
        }
        FakeProcess excessive = new FakeProcess("x".repeat(ValuationService.MAX_OUTPUT_BYTES + 1), 0, true);
        try (FakeService service = service(excessive, false)) {
            assertThat(assertThrows(ApiException.class, () -> service.simulate(request())).status()).isEqualTo(502);
            assertThat(excessive.destroyed).isTrue();
        }
    }

    @Test void serverLimitsInferenceToTwoConcurrentProcesses() throws Exception {
        CountDownLatch entered = new CountDownLatch(2);
        CountDownLatch release = new CountDownLatch(1);
        var executor = java.util.concurrent.Executors.newFixedThreadPool(2);
        ValuationService service = new ValuationService(json, "fixed-python", "fixed-worker.py", "fixed-model.joblib", false, 10) {
            @Override Process start(List<String> command) {
                return new FakeProcess(SUCCESS, 0, true) {
                    @Override public boolean waitFor(long timeout, TimeUnit unit) throws InterruptedException {
                        entered.countDown();
                        return release.await(timeout, unit);
                    }
                };
            }
        };
        try {
            JsonNode request = request();
            var first = executor.submit(() -> service.simulate(request));
            var second = executor.submit(() -> service.simulate(request));
            assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue();
            assertThat(assertThrows(ApiException.class, () -> service.simulate(request)).code()).isEqualTo("prediction_busy");
            release.countDown();
            assertThat(first.get(3, TimeUnit.SECONDS).path("ok").asBoolean()).isTrue();
            assertThat(second.get(3, TimeUnit.SECONDS).path("ok").asBoolean()).isTrue();
        } finally {
            release.countDown();
            service.close();
            executor.shutdownNow();
        }
    }

    private class FakeService extends ValuationService implements AutoCloseable {
        final FakeProcess process;
        List<String> command;
        FakeService(FakeProcess process, boolean allowLlm) {
            super(json, "fixed-python", "fixed-worker.py", "fixed-model.joblib", allowLlm, 1);
            this.process = process;
        }
        @Override Process start(List<String> command) { this.command = command; return process; }
    }

    private static class FakeProcess extends Process {
        final ByteArrayOutputStream stdin = new ByteArrayOutputStream();
        final InputStream stdout;
        final int exit;
        final boolean completed;
        boolean destroyed;
        FakeProcess(String output, int exit, boolean completed) {
            stdout = new ByteArrayInputStream(output.getBytes(StandardCharsets.UTF_8));
            this.exit = exit;
            this.completed = completed;
        }
        @Override public OutputStream getOutputStream() { return stdin; }
        @Override public InputStream getInputStream() { return stdout; }
        @Override public InputStream getErrorStream() { return InputStream.nullInputStream(); }
        @Override public int waitFor() { return exit; }
        @Override public boolean waitFor(long timeout, TimeUnit unit) throws InterruptedException { return completed; }
        @Override public int exitValue() { return exit; }
        @Override public void destroy() { destroyed = true; }
    }
}
