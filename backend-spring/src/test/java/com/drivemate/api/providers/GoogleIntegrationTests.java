package com.drivemate.api.providers;

import static com.drivemate.api.providers.ProviderSupport.map;
import static org.junit.jupiter.api.Assertions.*;
import com.drivemate.api.ApiException;
import com.drivemate.api.AppSettings;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.mock.env.MockEnvironment;

class GoogleIntegrationTests {
    private final ObjectMapper mapper = new ObjectMapper();
    private record Fixture(GoogleIntegration integration, JdbcTemplate jdbc) {}
    private ProviderSettings settings(String mode) {
        byte[] bytes = new byte[32]; Arrays.fill(bytes, (byte) 7);
        return new ProviderSettings(new AppSettings(mode, 12, "http://localhost:8081"), new MockEnvironment()
            .withProperty("DRIVEMATE_GOOGLE_CLIENT_ID", "synthetic-client")
            .withProperty("DRIVEMATE_GOOGLE_CLIENT_SECRET", "synthetic-secret")
            .withProperty("DRIVEMATE_GOOGLE_REDIRECT_URI", "http://localhost:18085/api/v1/integrations/google/callback")
            .withProperty("DRIVEMATE_TOKEN_ENCRYPTION_KEY", Base64.getUrlEncoder().encodeToString(bytes)));
    }
    private Fixture fixture(String mode, ProviderHttp.Transport transport) {
        DriverManagerDataSource source = new DriverManagerDataSource("jdbc:h2:mem:" + UUID.randomUUID() + ";MODE=PostgreSQL;DB_CLOSE_DELAY=-1", "sa", "");
        JdbcTemplate jdbc = new JdbcTemplate(source);
        jdbc.execute("CREATE TABLE accounts(id VARCHAR(100) PRIMARY KEY)");
        jdbc.update("INSERT INTO accounts(id) VALUES ('user-a'),('user-b')");
        ProviderSettings settings = settings(mode); ProviderHttp http = new ProviderHttp(mapper, transport);
        GoogleIntegration integration = new GoogleIntegration(jdbc, new DataSourceTransactionManager(source), settings,
            new GoogleOAuthClient(settings, http), new GoogleCalendarProvider(http, mapper), mapper);
        integration.schema(); return new Fixture(integration, jdbc);
    }
    private static String state(Map<String, Object> authorization) {
        String url = (String) authorization.get("authorization_url");
        assertTrue(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?"));
        assertTrue(url.contains("code_challenge_method=S256")); assertTrue(url.contains("access_type=offline"));
        assertFalse(url.contains("synthetic-secret"));
        return Arrays.stream(URI.create(url).getRawQuery().split("&")).filter(pair -> pair.startsWith("state="))
            .map(pair -> URLDecoder.decode(pair.substring(6), StandardCharsets.UTF_8)).findFirst().orElseThrow();
    }
    private ProviderHttp.Reply reply(Object data) throws java.io.IOException {
        return new ProviderHttp.Reply(200, mapper.writeValueAsBytes(data), null);
    }
    private Map<String, Object> token(String access, int seconds, boolean refresh) {
        Map<String, Object> result = map("access_token", access, "token_type", "Bearer", "expires_in", seconds, "scope", GoogleOAuthClient.SCOPE);
        if (refresh) result.put("refresh_token", "private-refresh-token"); return result;
    }
    private static OffsetDateTime start() { return OffsetDateTime.parse("2026-11-04T00:00:00Z"); }
    @Test void pkceOneUseStateEncryptedTokensAndPerAccountOwnership() {
        AtomicInteger calls = new AtomicInteger();
        Fixture fixture = fixture("live", request -> {
            calls.incrementAndGet(); assertEquals("oauth2.googleapis.com", request.uri().getHost());
            assertEquals("POST", request.method()); assertNull(request.uri().getQuery());
            return reply(token("private-access-token", 3600, true));
        });
        String state = state(fixture.integration.authorize("user-a"));
        String encryptedVerifier = fixture.jdbc.queryForObject("SELECT verifier FROM oauth_states", String.class);
        assertTrue(encryptedVerifier.startsWith("v1:"));
        fixture.integration.callback(state, "synthetic-code", null);
        assertEquals(1, calls.get()); assertEquals(true, fixture.integration.status("user-a").get("connected"));
        assertEquals(false, fixture.integration.status("user-b").get("connected"));
        String encrypted = fixture.jdbc.queryForObject("SELECT encrypted FROM provider_tokens", String.class);
        assertFalse(encrypted.contains("private-access-token")); assertFalse(encrypted.contains("private-refresh-token"));
        assertEquals("invalid_oauth_state", assertThrows(ApiException.class, () -> fixture.integration.callback(state, "synthetic-code", null)).code());
        assertEquals("google_not_connected", assertThrows(ApiException.class, () -> fixture.integration.listEvents("user-b", start(), start().plusDays(1))).code());
        assertEquals(1, calls.get());
    }
    @Test void expiredDeniedAndDisconnectedStateNeverReconnect() {
        AtomicReference<GoogleIntegration> integration = new AtomicReference<>(); AtomicInteger calls = new AtomicInteger();
        Fixture fixture = fixture("live", request -> {
            calls.incrementAndGet(); integration.get().disconnect("user-a");
            return reply(token("private-access-token", 3600, true));
        }); integration.set(fixture.integration);
        String expired = state(fixture.integration.authorize("user-a"));
        fixture.jdbc.update("UPDATE oauth_states SET expires_at = 0");
        assertEquals("invalid_oauth_state", assertThrows(ApiException.class, () -> fixture.integration.callback(expired, "code", null)).code());
        String denied = state(fixture.integration.authorize("user-a"));
        assertEquals("oauth_denied", assertThrows(ApiException.class, () -> fixture.integration.callback(denied, null, "access_denied")).code());
        assertEquals(0, calls.get());
        String pending = state(fixture.integration.authorize("user-a"));
        assertEquals("google_connection_changed", assertThrows(ApiException.class, () -> fixture.integration.callback(pending, "code", null)).code());
        assertEquals(false, fixture.integration.status("user-a").get("connected"));
    }
    @Test void refreshPreservesGrantAndDisconnectRevokesAndRemovesStates() {
        AtomicInteger exchanges = new AtomicInteger(), revocations = new AtomicInteger();
        Fixture fixture = fixture("live", request -> {
            if (request.uri().getPath().equals("/token")) {
                int number = exchanges.incrementAndGet();
                return reply(token(number == 1 ? "first-access" : "second-access", number == 1 ? 30 : 3600, number == 1));
            }
            if (request.uri().getPath().equals("/revoke")) { revocations.incrementAndGet(); return new ProviderHttp.Reply(200, new byte[0], null); }
            assertEquals("Bearer second-access", request.headers().firstValue("Authorization").orElseThrow());
            return reply(map("timeZone", "Asia/Seoul", "items", List.of()));
        });
        fixture.integration.callback(state(fixture.integration.authorize("user-a")), "code", null);
        fixture.integration.listEvents("user-a", start(), start().plusDays(1));
        assertEquals(2, exchanges.get());
        assertEquals(2L, fixture.jdbc.queryForObject("SELECT revision FROM provider_tokens", Long.class));
        fixture.integration.authorize("user-a");
        assertEquals(true, fixture.integration.disconnect("user-a").get("provider_revoked"));
        assertEquals(1, revocations.get()); assertEquals(0, fixture.jdbc.queryForObject("SELECT COUNT(*) FROM provider_tokens", Integer.class));
        assertEquals(0, fixture.jdbc.queryForObject("SELECT COUNT(*) FROM oauth_states", Integer.class));
    }
    @Test void calendar401RefreshesOnceBut403DoesNotDiscardGrant() {
        AtomicInteger tokenCalls = new AtomicInteger(), calendarCalls = new AtomicInteger();
        Fixture fixture = fixture("live", request -> {
            if (request.uri().getPath().equals("/token")) return reply(token("access-" + tokenCalls.incrementAndGet(), 3600, true));
            if (calendarCalls.incrementAndGet() == 1) return new ProviderHttp.Reply(401, new byte[0], null);
            return new ProviderHttp.Reply(403, new byte[0], null);
        });
        fixture.integration.callback(state(fixture.integration.authorize("user-a")), "code", null);
        ProviderException error = assertThrows(ProviderException.class, () -> fixture.integration.listEvents("user-a", start(), start().plusDays(1)));
        assertEquals(403, error.upstreamStatus()); assertEquals(2, tokenCalls.get()); assertEquals(2, calendarCalls.get());
        assertEquals(true, fixture.integration.status("user-a").get("connected"));
    }
    @Test void tokensAreCryptographicallyBoundToTheirAccount() {
        Fixture fixture = fixture("live", request -> reply(token("private-access", 3600, true)));
        fixture.integration.callback(state(fixture.integration.authorize("user-a")), "code", null);
        String encrypted = fixture.jdbc.queryForObject("SELECT encrypted FROM provider_tokens WHERE user_id='user-a'", String.class);
        fixture.jdbc.update("INSERT INTO provider_tokens(user_id,encrypted,revision) VALUES ('user-b',?,1)", encrypted);
        assertEquals("provider_reconnect_required", assertThrows(ApiException.class, () -> fixture.integration.listEvents("user-b", start(), start().plusDays(1))).code());
    }
    @Test void mockModeCannotStartConsentAndScopeCannotExpand() {
        Fixture mock = fixture("mock", request -> { throw new AssertionError("Mock consent must not call Google"); });
        assertEquals("oauth_not_configured", assertThrows(ApiException.class, () -> mock.integration.authorize("user-a")).code());
        Fixture broad = fixture("live", request -> reply(map("access_token", "private-access", "refresh_token", "private-refresh", "expires_in", 3600, "token_type", "Bearer", "scope", GoogleOAuthClient.SCOPE + " other-scope")));
        assertEquals("oauth_scope_mismatch", assertThrows(ProviderException.class, () -> broad.integration.callback(state(broad.integration.authorize("user-a")), "code", null)).code());
        assertEquals(false, broad.integration.status("user-a").get("connected"));
    }
}
