package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Arrays;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class KnowledgeController {
    private final Auth auth;
    private final Store store;
    private final KnowledgeService knowledge;
    private final PaidApiBudget budget;
    private final Set<String> allowedEmails;

    public KnowledgeController(Auth auth, Store store, KnowledgeService knowledge, PaidApiBudget budget,
            @Value("${DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS:}") String allowedEmails) {
        this.auth = auth;
        this.store = store;
        this.knowledge = knowledge;
        this.budget = budget;
        this.allowedEmails = Arrays.stream(allowedEmails.split(",")).map(String::strip)
                .map(email -> email.toLowerCase(Locale.ROOT)).filter(email -> !email.isEmpty()).collect(Collectors.toUnmodifiableSet());
    }

    @PostMapping("/api/v1/knowledge/query")
    public JsonNode query(@RequestBody JsonNode request, HttpServletRequest http) {
        var user = auth.require(http);
        if (!allowedEmails.contains(user.get("email"))) {
            throw new ApiException("knowledge_forbidden", "이 계정에는 프로젝트 문서 접근 권한이 없어요. 허용된 계정으로 로그인해 주세요.", 403);
        }
        KnowledgeService.validate(request);
        store.rateLimit("knowledge:" + user.get("id"), 12, 60);
        // Retrieval-only requests also call the paid embedding API.
        budget.consume();
        return knowledge.query(request);
    }
}
