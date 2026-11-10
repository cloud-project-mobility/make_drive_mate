package com.drivemate.api.providers;

import static com.drivemate.api.providers.ProviderSupport.*;
import com.fasterxml.jackson.databind.JsonNode;
import java.net.URI;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Component;

@Component
public class GoogleOAuthClient {
    public static final String SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
    public record Tokens(String accessToken, String refreshToken, String expiresAt, String refreshExpiresAt) {}
    private final ProviderSettings settings;
    private final ProviderHttp http;
    public GoogleOAuthClient(ProviderSettings settings, ProviderHttp http) { this.settings = settings; this.http = http; }
    public boolean configured() { try { configuration(); return true; } catch (ProviderException error) { return false; } }
    private void configuration() {
        try {
            secret(settings.googleClientId(), 1024); secret(settings.googleClientSecret(), 4096);
            String raw = secret(settings.googleRedirectUri(), 2048); URI uri = URI.create(raw);
            if (raw.contains("\\") || uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null || uri.getQuery() != null
                    || !"/api/v1/integrations/google/callback".equals(uri.getPath())
                    || uri.getPort() > 65535 || uri.getPort() == 0
                    || !(uri.getScheme().equals("https") || uri.getScheme().equals("http") && Set.of("localhost", "127.0.0.1", "::1", "[::1]").contains(uri.getHost()))) throw new IllegalArgumentException();
        } catch (IllegalArgumentException | NullPointerException error) {
            throw new ProviderException("oauth_not_configured", "Google 캘린더 OAuth 서버 설정이 필요합니다.", 503);
        }
    }
    public String authorizationUrl(String state, String challenge) {
        configuration();
        if (!state.matches("[A-Za-z0-9_-]{32,256}") || !challenge.matches("[A-Za-z0-9_-]{43}")) throw new IllegalArgumentException("Invalid OAuth state or PKCE challenge");
        Map<String, String> parameters = new LinkedHashMap<>();
        parameters.put("client_id", settings.googleClientId()); parameters.put("redirect_uri", settings.googleRedirectUri());
        parameters.put("response_type", "code"); parameters.put("scope", SCOPE); parameters.put("state", state);
        parameters.put("code_challenge", challenge); parameters.put("code_challenge_method", "S256");
        parameters.put("access_type", "offline"); parameters.put("prompt", "consent"); parameters.put("include_granted_scopes", "false");
        return "https://accounts.google.com/o/oauth2/v2/auth?" + ProviderHttp.form(parameters);
    }
    public Tokens exchange(String code, String verifier) {
        configuration(); secret(code, 4096);
        if (!verifier.matches("[A-Za-z0-9._~-]{43,128}")) throw new IllegalArgumentException("Invalid PKCE verifier");
        Instant started = Instant.now();
        return tokens(http.oauthPost("https://oauth2.googleapis.com/token", Map.of("client_id", settings.googleClientId(), "client_secret", settings.googleClientSecret(),
            "redirect_uri", settings.googleRedirectUri(), "grant_type", "authorization_code", "code", code, "code_verifier", verifier), false), started, false);
    }
    public Tokens refresh(String refreshToken) {
        configuration(); secret(refreshToken, 16384); Instant started = Instant.now();
        return tokens(http.oauthPost("https://oauth2.googleapis.com/token", Map.of("client_id", settings.googleClientId(), "client_secret", settings.googleClientSecret(),
            "grant_type", "refresh_token", "refresh_token", refreshToken), false), started, true);
    }
    public void revoke(String token) {
        configuration(); secret(token, 16384);
        http.oauthPost("https://oauth2.googleapis.com/revoke", Map.of("token", token), true);
    }
    private Tokens tokens(JsonNode value, Instant started, boolean inheritScope) {
        try {
            String access = secret(text(value.get("access_token"), 16384, false), 16384);
            String refresh = value.has("refresh_token") ? secret(text(value.get("refresh_token"), 16384, false), 16384) : null;
            long seconds = integer(value.get("expires_in"));
            if (seconds == 0 || !text(value.get("token_type"), 50, false).equalsIgnoreCase("bearer")) throw new IllegalArgumentException();
            String scope = value.has("scope") ? text(value.get("scope"), 2000, false) : inheritScope ? SCOPE : "";
            if (!scope.trim().equals(SCOPE)) throw new ProviderException("oauth_scope_mismatch", "캘린더 일정 읽기 권한만 승인된 연결이 필요합니다.", 403);
            Instant expiry = started.plusSeconds(seconds);
            if (!expiry.isAfter(Instant.now())) throw new IllegalArgumentException();
            String refreshExpiry = null;
            if (value.has("refresh_token_expires_in")) {
                long refreshSeconds = integer(value.get("refresh_token_expires_in")); Instant expiration = started.plusSeconds(refreshSeconds);
                if (refreshSeconds == 0 || !expiration.isAfter(Instant.now())) throw new IllegalArgumentException();
                refreshExpiry = expiration.toString();
            }
            return new Tokens(access, refresh, expiry.toString(), refreshExpiry);
        } catch (IllegalArgumentException | ArithmeticException | java.time.DateTimeException error) { throw malformed(); }
    }
}
