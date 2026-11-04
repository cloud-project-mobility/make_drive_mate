package com.drivemate.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:quotatest;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "DRIVEMATE_PROVIDER_MODE=mock", "DRIVEMATE_LLM_DAILY_LIMIT=2",
        "DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS=allowed@example.test"
})
@AutoConfigureMockMvc
class PaidLlmQuotaTest {
    @Autowired MockMvc http;
    @Autowired ObjectMapper json;
    @Autowired Store store;
    @MockitoBean ValuationService valuation;
    @MockitoBean KnowledgeService knowledge;

    @Test void paidQuotaIsSharedAcrossAccountsAndCheckedBeforeWorker() throws Exception {
        when(valuation.simulate(any())).thenReturn(json.readTree("{\"ok\":true}"));
        when(knowledge.query(any())).thenReturn(json.readTree("{\"ok\":true}"));
        String first = (String) store.register("allowed@example.test", "test-password").get("access_token");
        String second = (String) store.register(UUID.randomUUID() + "@example.test", "test-password").get("access_token");
        String request = """
                {"vehicle":{"model":"쏘나타","age_years":7,"odometer_km":151158},"use_llm":true}
                """;
        http.perform(post("/api/v1/valuation/simulations").header("Authorization", "Bearer " + first)
                .contentType(MediaType.APPLICATION_JSON).content(request)).andExpect(status().isOk());
        http.perform(post("/api/v1/knowledge/query").header("Authorization", "Bearer " + first)
                .contentType(MediaType.APPLICATION_JSON).content("{\"question\":\"프로젝트의 데이터 한계는?\",\"use_llm\":false}"))
                .andExpect(status().isOk());
        http.perform(post("/api/v1/valuation/simulations").header("Authorization", "Bearer " + second)
                .contentType(MediaType.APPLICATION_JSON).content(request)).andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("rate_limited"));
        http.perform(post("/api/v1/knowledge/query").header("Authorization", "Bearer " + second)
                .contentType(MediaType.APPLICATION_JSON).content("{\"question\":\"프로젝트 자료\"}"))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.error.code").value("knowledge_forbidden"));
        verify(valuation, times(1)).simulate(any());
        verify(knowledge, times(1)).query(any());
        // Unpaid model analysis remains available when the shared paid quota is exhausted.
        http.perform(post("/api/v1/valuation/simulations").header("Authorization", "Bearer " + first)
                .contentType(MediaType.APPLICATION_JSON).content(request.replace("true", "false"))).andExpect(status().isOk());
        verify(valuation, times(2)).simulate(any());
    }
}
