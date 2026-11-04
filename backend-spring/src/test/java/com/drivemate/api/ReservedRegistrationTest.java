package com.drivemate.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:reservedtest;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "DRIVEMATE_PROVIDER_MODE=mock", "DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS= Owner@Example.Test ",
        "DRIVEMATE_BOOTSTRAP_TOKEN=bootstrap-fixture-32-chars-not-a-real-secret"
})
@AutoConfigureMockMvc
class ReservedRegistrationTest {
    @Autowired MockMvc http;
    @Autowired ObjectMapper json;

    @Test void reservedEmailCannotBeClaimedBeforeBootstrapOrAfterDeletion() throws Exception {
        String body = "{\"email\":\"OWNER@example.test\",\"password\":\"test-password-2026\"}";
        http.perform(post("/api/v1/auth/register").contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.error.code").value("email_reserved"));
        http.perform(post("/api/v1/auth/register").header("X-DriveMate-Bootstrap-Token", "wrong")
                .contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isForbidden());
        var created = http.perform(post("/api/v1/auth/register")
                .header("X-DriveMate-Bootstrap-Token", "bootstrap-fixture-32-chars-not-a-real-secret")
                .contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isCreated()).andReturn();
        String token = json.readTree(created.getResponse().getContentAsString()).get("access_token").asText();
        http.perform(delete("/api/v1/account").header("Authorization", "Bearer " + token)).andExpect(status().isOk());
        http.perform(post("/api/v1/auth/register").contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.error.code").value("email_reserved"));
        http.perform(post("/api/v1/auth/register").contentType(MediaType.APPLICATION_JSON)
                .content(body.replace("OWNER@example.test", "public@example.test"))).andExpect(status().isCreated());
    }

    @Test void missingOrShortBootstrapConfigurationAlwaysRejectsReservedRegistration() {
        assertThatThrownBy(() -> new RegistrationPolicy("owner@example.test", "")
                .require("owner@example.test", "")).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> new RegistrationPolicy("owner@example.test", "short")
                .require("owner@example.test", "short")).isInstanceOf(ApiException.class);
    }
}
