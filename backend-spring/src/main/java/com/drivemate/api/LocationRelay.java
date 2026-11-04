package com.drivemate.api;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.nio.ByteBuffer;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PingMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;

/** Account-scoped foreground location relay. Coordinates never enter storage or logs. */
@Service
public class LocationRelay implements SessionDisconnect {
    static final String IDENTITY = "drivemate.location.identity";
    static final long TICKET_TTL_MS = 30_000;
    static final long POSITION_TTL_MS = 30_000;
    static final CloseStatus UNAUTHORIZED = new CloseStatus(4401, "Session ended");
    private static final Logger LOG = LoggerFactory.getLogger(LocationRelay.class);
    private static final SecureRandom RANDOM = new SecureRandom();
    private final Object monitor = new Object();
    // Fixed stripes bound memory while ordering state changes and delivery for
    // each account. Never acquire a lane while holding the state monitor.
    private final Object[] deliveryLanes = new Object[128];
    private final Store store;
    private final ObjectMapper json;
    private final Clock clock;
    private final Map<String, Ticket> tickets = new HashMap<>();
    private final Map<String, Connection> connections = new HashMap<>();
    private final ScheduledExecutorService heartbeat = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "location-heartbeat");
        thread.setDaemon(true);
        return thread;
    });

    private record Ticket(Store.SessionIdentity identity, String origin, long expiresAt) { }
    private record Delivery(List<Connection> recipients, Map<String, Object> message) { }

    private static final class Connection {
        final WebSocketSession socket;
        final Store.SessionIdentity identity;
        final String sourceId = UUID.randomUUID().toString();
        Map<String, Object> latest;
        Instant observedAt;
        long updatedAt;
        long lastPong;
        long lastPing;
        long windowStart;
        int messages;

        Connection(WebSocketSession socket, Store.SessionIdentity identity, long now) {
            this.socket = new ConcurrentWebSocketSessionDecorator(socket, 1_000, 8 * 1024);
            this.identity = identity;
            this.lastPong = now;
            this.lastPing = now;
            this.windowStart = now;
        }
    }

    public LocationRelay(Store store, ObjectMapper json, Clock clock) {
        this.store = store;
        this.json = json;
        this.clock = clock;
        Arrays.setAll(deliveryLanes, index -> new Object());
    }

    private Object lane(String userId) { return deliveryLanes[Math.floorMod(userId.hashCode(), deliveryLanes.length)]; }

    @PostConstruct public void start() {
        heartbeat.scheduleWithFixedDelay(() -> {
            try { maintain(); }
            catch (RuntimeException exception) {
                LOG.warn("Location connection maintenance failed; closing transient connections");
                List<String> identifiers;
                synchronized (monitor) { identifiers = List.copyOf(connections.keySet()); }
                identifiers.forEach(id -> close(id, CloseStatus.SERVER_ERROR));
            }
        }, 5, 5, TimeUnit.SECONDS);
    }

    public Map<String, String> issueTicket(Store.SessionIdentity identity, String origin) {
        store.rateLimit("location-ticket:" + identity.userId(), 10, 60);
        long expires = clock.millis() + TICKET_TTL_MS;
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        String value = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        synchronized (monitor) {
            tickets.entrySet().removeIf(entry -> entry.getValue().expiresAt() <= clock.millis());
            if (identity.expiresAt() <= clock.millis() || !store.sessionActive(identity)) throw unauthorized();
            if (tickets.size() >= 1_000 || connections.size() >= 100 || accountConnections(identity.userId()) >= 3) {
                throw new ApiException("location_busy", "연결 가능한 위치 화면 수를 초과했어요. 다른 연결을 종료해 주세요.", 429);
            }
            tickets.put(Store.digest(value), new Ticket(identity, origin, expires));
        }
        return Map.of("ticket", value, "expires_at", Instant.ofEpochMilli(expires).toString());
    }

    Store.SessionIdentity consumeTicket(String value, String origin) {
        Ticket ticket;
        synchronized (monitor) { ticket = tickets.remove(Store.digest(value)); }
        if (ticket == null || ticket.expiresAt() <= clock.millis() || !ticket.origin().equals(origin)
                || ticket.identity().expiresAt() <= clock.millis() || !store.sessionActive(ticket.identity())) throw unauthorized();
        return ticket.identity();
    }

    private static ApiException unauthorized() {
        return new ApiException("location_ticket_invalid", "위치 연결 인증이 만료됐어요. 다시 연결해 주세요.", 401);
    }

    private long accountConnections(String userId) {
        return connections.values().stream().filter(value -> value.identity.userId().equals(userId)).count();
    }

    public void connect(WebSocketSession socket) {
        socket.setTextMessageSizeLimit(1024);
        socket.setBinaryMessageSizeLimit(1024);
        Object identity = socket.getAttributes().get(IDENTITY);
        if (!(identity instanceof Store.SessionIdentity principal)) {
            closeSocket(socket, UNAUTHORIZED);
            return;
        }
        synchronized (lane(principal.userId())) { connectOrdered(socket, principal); }
    }

    private void connectOrdered(WebSocketSession socket, Store.SessionIdentity principal) {
        Connection connection;
        List<Map<String, Object>> latest = new ArrayList<>();
        synchronized (monitor) {
            // Register under the same lock used by logout cleanup, after checking the
            // database, so a consumed ticket cannot race a revoked session into use.
            if (principal.expiresAt() <= clock.millis() || !store.sessionActive(principal)) {
                closeSocket(socket, UNAUTHORIZED);
                return;
            }
            if (connections.size() >= 100 || accountConnections(principal.userId()) >= 3) {
                closeSocket(socket, new CloseStatus(1013, "Connection limit"));
                return;
            }
            connection = new Connection(socket, principal, clock.millis());
            for (Connection other : connections.values()) {
                if (other.identity.userId().equals(principal.userId()) && other.latest != null
                        && clock.millis() - other.updatedAt < POSITION_TTL_MS) latest.add(other.latest);
            }
            connections.put(socket.getId(), connection);
        }
        send(connection, Map.of("type", "ready", "source_id", connection.sourceId));
        latest.forEach(position -> send(connection, position));
    }

    public void receive(String socketId, TextMessage message) {
        Connection connection;
        synchronized (monitor) { connection = connections.get(socketId); }
        if (connection != null) {
            synchronized (lane(connection.identity.userId())) { receiveOrdered(socketId, message); }
        }
    }

    private void receiveOrdered(String socketId, TextMessage message) {
        if (message.getPayloadLength() > 1024) {
            close(socketId, CloseStatus.TOO_BIG_TO_PROCESS);
            return;
        }
        Delivery delivery = null;
        try {
            JsonNode input = json.reader().with(JsonParser.Feature.STRICT_DUPLICATE_DETECTION).readTree(message.getPayload());
            String type = input != null ? input.path("type").asText() : "";
            Instant observed = null;
            double latitude = 0, longitude = 0, accuracy = 0;
            if (type.equals("position")) {
                SnapshotValidator.fields(input, Set.of("type", "latitude", "longitude", "accuracy_m", "observed_at"), Set.of());
                latitude = coordinate(input, "latitude", -90, 90);
                longitude = coordinate(input, "longitude", -180, 180);
                accuracy = coordinate(input, "accuracy_m", 0, 10_000);
                observed = Instant.parse(SnapshotValidator.text(input, "observed_at", 40));
                long age = clock.millis() - observed.toEpochMilli();
                if (age > 120_000 || age < -30_000) throw new IllegalArgumentException("Invalid observation time");
            } else if (type.equals("stop")) {
                SnapshotValidator.fields(input, Set.of("type"), Set.of());
            } else {
                throw new IllegalArgumentException("Unsupported event");
            }
            synchronized (monitor) {
                Connection connection = connections.get(socketId);
                if (connection == null) return;
                if (connection.identity.expiresAt() <= clock.millis()) {
                    throw unauthorized();
                }
                if (clock.millis() - connection.windowStart >= 1_000) {
                    connection.windowStart = clock.millis();
                    connection.messages = 0;
                }
                if (++connection.messages > 2) throw new IllegalArgumentException("Rate limit");
                if (type.equals("stop")) {
                    delivery = forget(connection);
                } else if (connection.observedAt == null || observed.isAfter(connection.observedAt)) {
                    connection.observedAt = observed;
                    connection.updatedAt = clock.millis();
                    connection.latest = Map.of("type", "position", "source_id", connection.sourceId,
                            "latitude", latitude, "longitude", longitude, "accuracy_m", accuracy,
                            "observed_at", observed.toString(), "received_at", clock.instant().toString());
                    delivery = new Delivery(recipients(connection), connection.latest);
                }
            }
            deliver(delivery);
        } catch (Exception exception) {
            // Neither invalid JSON nor coordinates belong in exception/log output.
            close(socketId, exception instanceof ApiException api && api.status() == 401
                    ? UNAUTHORIZED : CloseStatus.POLICY_VIOLATION);
        }
    }

    private static double coordinate(JsonNode input, String key, double minimum, double maximum) {
        JsonNode value = input.get(key);
        if (value == null || !value.isNumber() || !Double.isFinite(value.asDouble())
                || value.asDouble() < minimum || value.asDouble() > maximum) throw new IllegalArgumentException("Invalid coordinate");
        return value.asDouble();
    }

    private List<Connection> recipients(Connection source) {
        return connections.values().stream().filter(value -> value != source
                && value.identity.userId().equals(source.identity.userId())).toList();
    }

    private Delivery forget(Connection connection) {
        if (connection.latest == null) return null;
        connection.latest = null;
        return new Delivery(recipients(connection), Map.of("type", "stopped", "source_id", connection.sourceId));
    }

    private void deliver(Delivery delivery) {
        if (delivery != null) delivery.recipients().forEach(connection -> send(connection, delivery.message()));
    }

    private void send(Connection connection, Map<String, Object> message) {
        try { sendFrame(connection, new TextMessage(json.writeValueAsString(message))); }
        catch (Exception exception) { close(connection.socket.getId(), CloseStatus.SERVER_ERROR); }
    }

    private void sendFrame(Connection connection, WebSocketMessage<?> message) {
        try {
            if (connection.identity.expiresAt() <= clock.millis()) {
                close(connection.socket.getId(), UNAUTHORIZED);
                return;
            }
            if (connection.socket.isOpen()) connection.socket.sendMessage(message);
        } catch (Exception exception) {
            close(connection.socket.getId(), CloseStatus.SERVER_ERROR);
        }
    }

    public void pong(String socketId) {
        synchronized (monitor) {
            Connection connection = connections.get(socketId);
            if (connection != null) connection.lastPong = clock.millis();
        }
    }

    void maintain() {
        List<Connection> inspect;
        synchronized (monitor) {
            tickets.entrySet().removeIf(entry -> entry.getValue().expiresAt() <= clock.millis());
            inspect = List.copyOf(connections.values());
        }
        for (Connection connection : inspect) {
            synchronized (lane(connection.identity.userId())) {
                Delivery expired;
                boolean checkSession;
                synchronized (monitor) {
                    if (connections.get(connection.socket.getId()) != connection) continue;
                    long now = clock.millis();
                    expired = connection.latest != null && now - connection.updatedAt >= POSITION_TTL_MS ? forget(connection) : null;
                    checkSession = now - connection.lastPing >= 20_000 || connection.identity.expiresAt() <= now;
                    if (checkSession) connection.lastPing = now;
                }
                deliver(expired);
                if (!checkSession) continue;
                try {
                    if (connection.identity.expiresAt() <= clock.millis() || !store.sessionActive(connection.identity)) {
                        close(connection.socket.getId(), UNAUTHORIZED);
                    } else if (clock.millis() - connection.lastPong >= 60_000) {
                        close(connection.socket.getId(), CloseStatus.GOING_AWAY);
                    } else {
                        sendFrame(connection, new PingMessage(ByteBuffer.allocate(0)));
                    }
                } catch (RuntimeException exception) { close(connection.socket.getId(), CloseStatus.SERVER_ERROR); }
            }
        }
    }

    public void disconnected(String socketId) { close(socketId, CloseStatus.NORMAL); }

    public void close(String socketId, CloseStatus status) {
        Connection connection;
        synchronized (monitor) { connection = connections.get(socketId); }
        if (connection != null) {
            synchronized (lane(connection.identity.userId())) { closeOrdered(socketId, status); }
        }
    }

    private void closeOrdered(String socketId, CloseStatus status) {
        Connection removed;
        Delivery stopped;
        synchronized (monitor) {
            removed = connections.remove(socketId);
            stopped = removed == null ? null : forget(removed);
        }
        if (removed != null) closeSocket(removed.socket, status);
        deliver(stopped);
    }

    private static void closeSocket(WebSocketSession socket, CloseStatus status) {
        try { if (socket.isOpen()) socket.close(status); }
        catch (Exception ignored) { /* Disconnected socket is already removed from memory. */ }
    }

    @Override public void disconnectSession(String tokenHash) { revoke(tokenHash, null); }
    @Override public void disconnectAccountSessions(String userId) { revoke(null, userId); }

    private void revoke(String tokenHash, String userId) {
        List<String> close;
        synchronized (monitor) {
            tickets.entrySet().removeIf(entry -> matches(entry.getValue().identity(), tokenHash, userId));
            close = connections.entrySet().stream().filter(entry -> matches(entry.getValue().identity, tokenHash, userId))
                    .map(Map.Entry::getKey).toList();
        }
        close.forEach(id -> close(id, UNAUTHORIZED));
    }

    private static boolean matches(Store.SessionIdentity identity, String hash, String userId) {
        return hash != null ? identity.tokenHash().equals(hash) : identity.userId().equals(userId);
    }

    @PreDestroy public void stop() {
        heartbeat.shutdownNow();
        List<String> identifiers;
        synchronized (monitor) {
            tickets.clear();
            identifiers = List.copyOf(connections.keySet());
        }
        identifiers.forEach(id -> close(id, CloseStatus.GOING_AWAY));
    }
}
