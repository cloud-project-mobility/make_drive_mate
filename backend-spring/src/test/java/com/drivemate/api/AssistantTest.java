package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.servlet.http.HttpServletRequest;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.*;

class AssistantTest {
    private final ObjectMapper json = new ObjectMapper();
    private JsonNode request() throws Exception {
        return json.readTree("""
                {"question":"K5를 팔기 전 무엇을 확인하나요?","context":{"demo":false,
                "vehicle":{"powertrain":"ICE","odometer_km":12345},"maintenance":[],"next_plan":null}}
                """);
    }

    @Test void requiresSessionBeforeBudgetOrProvider() throws Exception {
        Auth auth = mock(Auth.class);
        Store store = mock(Store.class);
        AssistantService service = mock(AssistantService.class);
        PaidApiBudget budget = mock(PaidApiBudget.class);
        HttpServletRequest http = mock(HttpServletRequest.class);
        when(auth.require(http)).thenThrow(new ApiException("unauthorized", "login", 401));
        var controller = new AssistantController(auth, store, service, budget);
        assertThat(assertThrows(ApiException.class, () -> controller.query(request(), http)).status()).isEqualTo(401);
        verifyNoInteractions(store, service, budget);
    }

    @Test void authenticatedAccountUsesSameSharedPaidBudgetAndCannotSupplySecrets() throws Exception {
        Auth auth = mock(Auth.class);
        Store store = mock(Store.class);
        AssistantService service = mock(AssistantService.class);
        PaidApiBudget budget = mock(PaidApiBudget.class);
        HttpServletRequest http = mock(HttpServletRequest.class);
        when(auth.require(http)).thenReturn(Map.of("id", "synthetic-account"));
        var controller = new AssistantController(auth, store, service, budget);
        var input = request();
        controller.query(input, http);
        verify(store).rateLimit("assistant:synthetic-account", 12, 60);
        verify(budget).consume();
        verify(service).query(input);
        var bad = request();
        ((ObjectNode) bad.get("context")).put("address", "private-synthetic");
        assertThrows(ApiException.class, () -> controller.query(bad, http));
        verify(budget, times(1)).consume();
    }

    @Test void disabledServiceAndExhaustedBudgetNeverStartProvider() throws Exception {
        try (var service = new AssistantService(json, "python", "fixed/onbid_worker.py", "", false)) {
            assertThat(assertThrows(ApiException.class, () -> service.query(request())).code()).isEqualTo("llm_disabled");
        }
        Auth auth = mock(Auth.class);
        Store store = mock(Store.class);
        AssistantService service = mock(AssistantService.class);
        PaidApiBudget budget = mock(PaidApiBudget.class);
        HttpServletRequest http = mock(HttpServletRequest.class);
        when(auth.require(http)).thenReturn(Map.of("id", "synthetic"));
        doThrow(new ApiException("rate_limited", "limit", 429)).when(budget).consume();
        assertThat(assertThrows(ApiException.class, () -> new AssistantController(auth, store, service, budget).query(request(), http)).status()).isEqualTo(429);
        verify(service, never()).query(any());
    }

    @Test void unknownContextClientPricesAndNestedLlmCallsAreRejected() throws Exception {
        for (String field : List.of("note", "latitude", "email", "facts")) {
            var bad = request();
            ((ObjectNode) bad.get("context")).put(field, "private");
            assertThrows(ApiException.class, () -> AssistantService.validate(bad));
        }
        for (String extra : List.of("\"prediction_krw\":1", "\"use_llm\":true")) {
            var bad = (ObjectNode) request();
            bad.set("analysis", json.readTree("{\"vehicle\":{\"model\":\"K5\",\"age_years\":5,\"odometer_km\":1000}," + extra + "}"));
            assertThrows(ApiException.class, () -> AssistantService.validate(bad));
        }
    }

    @Test void fixedWorkerAndOneStructuredRequestDoNotExposeStderr() throws Exception {
        String output = "{\"ok\":true,\"api_version\":\"assistant-v1\",\"answer\":\"확인해 보세요\",\"facts\":[],\"price_generation_by_llm\":false}";
        ByteArrayOutputStream stdin = new ByteArrayOutputStream();
        try (var service = new AssistantService(json, "fixed-python", "fixed/onbid_worker.py", "model", true) {
            @Override Process start(List<String> command) {
                assertThat(command).containsExactly("fixed-python", "fixed/assistant_worker.py", "--allow-llm");
                return new Process() {
                    public OutputStream getOutputStream() { return stdin; }
                    public InputStream getInputStream() { return new ByteArrayInputStream(output.getBytes(StandardCharsets.UTF_8)); }
                    public InputStream getErrorStream() { return new ByteArrayInputStream("private".getBytes(StandardCharsets.UTF_8)); }
                    public int waitFor() { return 0; }
                    public boolean waitFor(long timeout, TimeUnit unit) { return true; }
                    public int exitValue() { return 0; }
                    public void destroy() { }
                    public Process destroyForcibly() { return this; }
                };
            }
        }) {
            assertThat(service.query(request()).path("ok").asBoolean()).isTrue();
            assertThat(json.readTree(stdin.toByteArray())).isEqualTo(request());
        }
    }
}
