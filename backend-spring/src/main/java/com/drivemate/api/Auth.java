package com.drivemate.api;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
public class Auth {
    private final Store store;

    public Auth(Store store) { this.store = store; }

    public String token(HttpServletRequest request) {
        String authorization = request.getHeader("Authorization");
        if (authorization == null || !authorization.startsWith("Bearer ") || authorization.length() > 256
                || authorization.length() <= 7) {
            throw new ApiException("unauthorized", "로그인이 필요해요.", 401);
        }
        return authorization.substring(7);
    }

    public Map<String, Object> require(HttpServletRequest request) {
        return store.authenticate(token(request));
    }

    public Store.SessionIdentity requireSession(HttpServletRequest request) {
        return store.authenticateSession(token(request));
    }

    public Map<String, Object> requireProvider(HttpServletRequest request) {
        Map<String, Object> user = require(request);
        store.rateLimit("provider:" + user.get("id"), 120, 60);
        return user;
    }
}
