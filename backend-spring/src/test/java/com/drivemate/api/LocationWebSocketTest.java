package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.nio.ByteBuffer;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "spring.datasource.url=jdbc:h2:mem:locationtest;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "DRIVEMATE_PROVIDER_MODE=mock", "server.forward-headers-strategy=framework"
})
@Import(LocationWebSocketTest.TimeConfiguration.class)
class LocationWebSocketTest {
    private static final String ORIGIN = "http://localhost:8081";
    @Value("${local.server.port}") int port;
    @Autowired Store store;
    @Autowired LocationRelay relay;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired AdjustableClock clock;
    private final HttpClient client = HttpClient.newHttpClient();
    private final List<WebSocket> sockets = new ArrayList<>();

    static class AdjustableClock extends Clock {
        final AtomicLong offset = new AtomicLong();
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return Instant.now().plusMillis(offset.get()); }
    }

    @TestConfiguration static class TimeConfiguration {
        @Bean @Primary AdjustableClock adjustableClock() { return new AdjustableClock(); }
    }

    @BeforeEach void resetClock() { clock.offset.set(0); }
    @AfterEach void disconnect() { sockets.forEach(WebSocket::abort); }

    private record Login(String email, String token, String userId) { }
    private Login register() {
        String email = UUID.randomUUID() + "@example.test";
        Map<String, Object> result = store.register(email, "location-test-password");
        return new Login(email, (String) result.get("access_token"), (String) ((Map<?, ?>) result.get("user")).get("id"));
    }
    private String loginAgain(Login account) { return (String) store.login(account.email(), "location-test-password").get("access_token"); }

    private HttpResponse<String> request(String path, String method, String token, String origin) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1" + path))
                .header("Authorization", "Bearer " + token).method(method, HttpRequest.BodyPublishers.noBody());
        if (origin != null) builder.header("Origin", origin);
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    private String ticket(String token) throws Exception {
        HttpResponse<String> response = request("/location/ticket", "POST", token, ORIGIN);
        assertThat(response.statusCode()).isEqualTo(200);
        return json.readTree(response.body()).path("ticket").asText();
    }

    private final class Listener implements WebSocket.Listener {
        final BlockingQueue<JsonNode> messages = new LinkedBlockingQueue<>();
        final CompletableFuture<Integer> closed = new CompletableFuture<>();
        final StringBuilder partial = new StringBuilder();
        WebSocket socket;
        @Override public void onOpen(WebSocket socket) { this.socket = socket; socket.request(1); }
        @Override public CompletionStage<?> onText(WebSocket socket, CharSequence text, boolean last) {
            partial.append(text);
            if (last) {
                try { messages.add(json.readTree(partial.toString())); }
                catch (Exception exception) { closed.completeExceptionally(exception); }
                partial.setLength(0);
            }
            socket.request(1);
            return CompletableFuture.completedFuture(null);
        }
        @Override public CompletionStage<?> onPing(WebSocket socket, ByteBuffer message) {
            socket.request(1);
            return socket.sendPong(message);
        }
        @Override public CompletionStage<?> onClose(WebSocket socket, int code, String reason) {
            closed.complete(code);
            return CompletableFuture.completedFuture(null);
        }
        @Override public void onError(WebSocket socket, Throwable error) { closed.completeExceptionally(error); }
        JsonNode next() throws Exception {
            JsonNode value = messages.poll(5, TimeUnit.SECONDS);
            assertThat(value).as("expected server event").isNotNull();
            return value;
        }
    }

    private Listener connect(String ticket, String origin, String query) throws Exception {
        Listener listener = new Listener();
        WebSocket.Builder builder = client.newWebSocketBuilder().subprotocols(LocationSocketHandler.PROTOCOL, "ticket." + ticket);
        if (origin != null) builder.header("Origin", origin);
        WebSocket socket = builder.buildAsync(URI.create("ws://localhost:" + port + "/api/v1/location/stream" + query), listener)
                .get(5, TimeUnit.SECONDS);
        sockets.add(socket);
        assertThat(socket.getSubprotocol()).isEqualTo(LocationSocketHandler.PROTOCOL);
        assertThat(listener.next().path("type").asText()).isEqualTo("ready");
        return listener;
    }

    private Listener open(String token) throws Exception { return connect(ticket(token), ORIGIN, ""); }
    private void denied(String ticket, String origin, String query, int status) {
        ExecutionException exception = assertThrows(ExecutionException.class, () -> connect(ticket, origin, query));
        assertThat(exception.getCause()).isInstanceOf(WebSocketHandshakeException.class);
        assertThat(((WebSocketHandshakeException) exception.getCause()).getResponse().statusCode()).isEqualTo(status);
    }

    private void position(Listener listener) throws Exception {
        listener.socket.sendText(json.writeValueAsString(Map.of("type", "position", "latitude", 37.5,
                "longitude", 127.1, "accuracy_m", 8, "observed_at", clock.instant().toString())), true).get(5, TimeUnit.SECONDS);
    }

    @Test void realSocketsRelayOnlyToSameAccountAndProvideShortLivedSnapshot() throws Exception {
        Login account = register();
        Listener publisher = open(account.token());
        Listener receiver = open(loginAgain(account));
        Listener stranger = open(register().token());
        position(publisher);
        JsonNode location = receiver.next();
        assertThat(location.path("type").asText()).isEqualTo("position");
        assertThat(location.path("latitude").asDouble()).isEqualTo(37.5);
        assertThat(location.has("user_id")).isFalse();
        assertThat(stranger.messages.poll(200, TimeUnit.MILLISECONDS)).isNull();
        assertThat(publisher.messages.poll(200, TimeUnit.MILLISECONDS)).isNull();
        Listener lateReceiver = open(loginAgain(account));
        assertThat(lateReceiver.next().path("source_id")).isEqualTo(location.path("source_id"));
        publisher.socket.sendText("{\"type\":\"stop\"}", true).get(5, TimeUnit.SECONDS);
        assertThat(receiver.next().path("type").asText()).isEqualTo("stopped");
        assertThat(lateReceiver.next().path("type").asText()).isEqualTo("stopped");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM snapshots WHERE user_id=?", Long.class, account.userId())).isZero();
    }

    @Test void ticketsRequireOriginAreSingleUseAndExpireWithoutQueryCredentials() throws Exception {
        Login account = register();
        assertThat(request("/location/ticket", "POST", "invalid-token", ORIGIN).statusCode()).isEqualTo(401);
        assertThat(request("/location/ticket", "POST", account.token(), null).statusCode()).isEqualTo(403);
        String first = ticket(account.token());
        connect(first, ORIGIN, "");
        denied(first, ORIGIN, "", 401);
        String unused = ticket(account.token());
        denied(unused, "https://attacker.example", "", 403);
        denied(unused, null, "", 403);
        denied(unused, "null", "", 403);
        denied(unused, ORIGIN, "?ticket=forbidden", 400);
        denied(ticket(account.token()), "http://127.0.0.1:8081", "", 401);
        clock.offset.addAndGet(LocationRelay.TICKET_TTL_MS + 1);
        denied(unused, ORIGIN, "", 401);
    }

    @Test void logoutAndAccountDeletionCloseSocketsAndInvalidateOutstandingTickets() throws Exception {
        Login account = register();
        String otherToken = loginAgain(account);
        Listener current = open(account.token());
        Listener other = open(otherToken);
        String pending = ticket(account.token());
        assertThat(request("/auth/logout", "POST", account.token(), ORIGIN).statusCode()).isEqualTo(200);
        assertThat(current.closed.get(5, TimeUnit.SECONDS)).isEqualTo(4401);
        denied(pending, ORIGIN, "", 401);
        assertThat(other.closed.isDone()).isFalse();
        String otherPending = ticket(otherToken);
        assertThat(request("/account", "DELETE", otherToken, ORIGIN).statusCode()).isEqualTo(200);
        assertThat(other.closed.get(5, TimeUnit.SECONDS)).isEqualTo(4401);
        denied(otherPending, ORIGIN, "", 401);
    }

    @Test void invalidPayloadSizeCoordinatesAndRatesTerminateTheConnection() throws Exception {
        Login account = register();
        Listener unknown = open(account.token());
        unknown.socket.sendText("{\"type\":\"stop\",\"user_id\":\"another-account\"}", true).get(5, TimeUnit.SECONDS);
        assertThat(unknown.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1008);
        Listener invalid = open(account.token());
        invalid.socket.sendText("{\"type\":\"position\",\"latitude\":999,\"longitude\":127,\"accuracy_m\":2,\"observed_at\":\"" + clock.instant() + "\"}", true).get(5, TimeUnit.SECONDS);
        assertThat(invalid.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1008);
        Listener large = open(account.token());
        large.socket.sendText("x".repeat(2048), true).get(5, TimeUnit.SECONDS);
        assertThat(large.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1009);
        Listener fast = open(account.token());
        for (int index = 0; index < 3; index++) fast.socket.sendText("{\"type\":\"stop\"}", true).get(5, TimeUnit.SECONDS);
        assertThat(fast.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1008);
        Listener duplicate = open(account.token());
        duplicate.socket.sendText("{\"type\":\"stop\",\"type\":\"stop\"}", true).get(5, TimeUnit.SECONDS);
        assertThat(duplicate.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1008);
        Listener binary = open(account.token());
        binary.socket.sendBinary(ByteBuffer.wrap(new byte[]{1}), true).get(5, TimeUnit.SECONDS);
        assertThat(binary.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1003);
    }

    @Test void coordinateTtlRemovesPositionsAndConnectionLimitIsAccountScoped() throws Exception {
        Login account = register();
        Listener publisher = open(account.token());
        Listener receiver = open(loginAgain(account));
        position(publisher);
        receiver.next();
        clock.offset.addAndGet(LocationRelay.POSITION_TTL_MS + 1);
        relay.maintain();
        assertThat(receiver.next().path("type").asText()).isEqualTo("stopped");
        Listener late = open(loginAgain(account));
        assertThat(late.messages.poll(200, TimeUnit.MILLISECONDS)).isNull();
        assertThat(request("/location/ticket", "POST", account.token(), ORIGIN).statusCode()).isEqualTo(429);
    }

    @Test void databaseSessionExpiryIsDetectedByHeartbeat() throws Exception {
        Login account = register();
        Listener listener = open(account.token());
        jdbc.update("UPDATE sessions SET expires_at=? WHERE token_hash=?", System.currentTimeMillis() - 1, Store.digest(account.token()));
        clock.offset.addAndGet(20_001);
        relay.maintain();
        assertThat(listener.closed.get(5, TimeUnit.SECONDS)).isEqualTo(4401);
    }

    @Test void trustedProxyForwardedHostSupportsProductionSameOriginHandshake() throws Exception {
        Login account = register();
        String origin = "https://example.cloudfront.net";
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1/location/ticket"))
                .header("Authorization", "Bearer " + account.token()).header("Origin", origin)
                .header("X-Forwarded-Host", "example.cloudfront.net").header("X-Forwarded-Proto", "https")
                .POST(HttpRequest.BodyPublishers.noBody()).build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).isEqualTo(200);
        String ticket = json.readTree(response.body()).path("ticket").asText();
        Listener listener = new Listener();
        WebSocket socket = client.newWebSocketBuilder().header("Origin", origin)
                .header("X-Forwarded-Host", "example.cloudfront.net").header("X-Forwarded-Proto", "https")
                .subprotocols(LocationSocketHandler.PROTOCOL, "ticket." + ticket)
                .buildAsync(URI.create("ws://localhost:" + port + "/api/v1/location/stream"), listener).get(5, TimeUnit.SECONDS);
        sockets.add(socket);
        assertThat(socket.getSubprotocol()).isEqualTo(LocationSocketHandler.PROTOCOL);
        assertThat(listener.next().path("type").asText()).isEqualTo("ready");
    }
}
