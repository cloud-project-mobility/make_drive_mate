package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AssistantController {
    private final Auth auth;
    private final Store store;
    private final AssistantService assistant;
    private final PaidApiBudget budget;

    public AssistantController(Auth auth, Store store, AssistantService assistant, PaidApiBudget budget) {
        this.auth = auth;
        this.store = store;
        this.assistant = assistant;
        this.budget = budget;
    }

    @PostMapping("/api/v1/assistant/query")
    public JsonNode query(@RequestBody JsonNode request, HttpServletRequest http) {
        String userId = (String) auth.require(http).get("id");
        AssistantService.validate(request);
        assistant.requireEnabled();
        store.rateLimit("assistant:" + userId, 12, 60);
        // Same global UTC daily budget as price explanation and document Q&A.
        budget.consume();
        return assistant.query(request);
    }
}
