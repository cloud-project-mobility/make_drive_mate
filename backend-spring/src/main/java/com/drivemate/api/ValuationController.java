package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ValuationController {
    private final Auth auth;
    private final Store store;
    private final ValuationService valuation;
    private final PaidApiBudget budget;

    public ValuationController(Auth auth, Store store, ValuationService valuation,
            PaidApiBudget budget) {
        this.auth = auth;
        this.store = store;
        this.valuation = valuation;
        this.budget = budget;
    }

    @PostMapping("/api/v1/valuation/simulations")
    public JsonNode simulate(@RequestBody JsonNode request, HttpServletRequest http) {
        String userId = (String) auth.require(http).get("id");
        store.rateLimit("valuation:" + userId, 12, 60);
        ValuationService.validate(request);
        if (request.path("use_llm").asBoolean(false)) {
            // One shared DB bucket across all users and API instances; UTC calendar day.
            budget.consume();
        }
        return valuation.simulate(request);
    }
}
