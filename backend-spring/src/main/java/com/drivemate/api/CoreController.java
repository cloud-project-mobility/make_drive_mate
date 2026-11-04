package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
public class CoreController {
    private final Store store;
    private final Auth auth;
    private final AppSettings settings;
    private final SnapshotValidator snapshots;
    private final List<AccountDisconnect> disconnectors;
    private final List<SessionDisconnect> sessionDisconnectors;
    private final RegistrationPolicy registrationPolicy;

    public CoreController(Store store, Auth auth, AppSettings settings, SnapshotValidator snapshots,
            List<AccountDisconnect> disconnectors, RegistrationPolicy registrationPolicy,
            List<SessionDisconnect> sessionDisconnectors) {
        this.store = store;
        this.auth = auth;
        this.settings = settings;
        this.snapshots = snapshots;
        this.disconnectors = disconnectors;
        this.sessionDisconnectors = sessionDisconnectors;
        this.registrationPolicy = registrationPolicy;
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        store.health();
        return Map.of("status", "ok", "provider_mode", settings.providerMode(), "schema_version", 2,
                "backend", "spring", "version", "0.2.0");
    }

    @PostMapping("/auth/register")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> register(@RequestBody JsonNode body, HttpServletRequest request) {
        String[] credentials = credentials(body);
        limit(request, credentials[0]);
        registrationPolicy.require(credentials[0], request.getHeader("X-DriveMate-Bootstrap-Token"));
        return store.register(credentials[0], credentials[1]);
    }

    @PostMapping("/auth/login")
    public Map<String, Object> login(@RequestBody JsonNode body, HttpServletRequest request) {
        String[] credentials = credentials(body);
        limit(request, credentials[0]);
        return store.login(credentials[0], credentials[1]);
    }

    @GetMapping("/auth/me")
    public Map<String, Object> me(HttpServletRequest request) { return auth.require(request); }

    @PostMapping("/auth/logout")
    public Map<String, Boolean> logout(HttpServletRequest request) {
        String token = auth.token(request);
        store.logout(token);
        for (SessionDisconnect disconnector : sessionDisconnectors) disconnector.disconnectSession(Store.digest(token));
        return Map.of("ok", true);
    }

    @DeleteMapping("/account")
    public Map<String, Boolean> deleteAccount(HttpServletRequest request) {
        String userId = (String) auth.require(request).get("id");
        for (AccountDisconnect disconnector : disconnectors) disconnector.disconnectAccount(userId);
        store.deleteAccount(userId);
        for (SessionDisconnect disconnector : sessionDisconnectors) disconnector.disconnectAccountSessions(userId);
        return Map.of("ok", true);
    }

    @GetMapping("/state")
    public Map<String, Object> state(HttpServletRequest request) {
        return store.state((String) auth.require(request).get("id"));
    }

    @PutMapping("/state")
    public Map<String, Object> saveState(@RequestBody JsonNode body, HttpServletRequest request) {
        String userId = (String) auth.require(request).get("id");
        long expected = snapshots.validateUpload(body);
        return store.saveState(userId, expected, body.get("state"));
    }

    private static String[] credentials(JsonNode body) {
        SnapshotValidator.fields(body, Set.of("email", "password"), Set.of());
        String email = SnapshotValidator.text(body, "email", 254).strip().toLowerCase(Locale.ROOT);
        String password = SnapshotValidator.text(body, "password", 128);
        if (!email.matches("[^\\s@]+@[^\\s@]+\\.[^\\s@]+") || email.length() < 3 || password.length() < 10) {
            throw ApiException.invalid();
        }
        return new String[]{email, password};
    }

    private void limit(HttpServletRequest request, String email) {
        // Do not trust client-supplied forwarding headers. Account buckets also limit shared proxy traffic.
        store.rateLimit("auth-ip:" + Store.digest(request.getRemoteAddr()), 30, 60);
        store.rateLimit("auth-email:" + Store.digest(email), 10, 60);
    }
}
