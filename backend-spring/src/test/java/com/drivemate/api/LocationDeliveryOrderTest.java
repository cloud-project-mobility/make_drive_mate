package com.drivemate.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class LocationDeliveryOrderTest {
    private final ObjectMapper json = new ObjectMapper();

    private WebSocketSession socket(String id, Store.SessionIdentity identity, List<String> events,
            CountDownLatch readyStarted, CountDownLatch readyRelease) throws Exception {
        WebSocketSession socket = mock(WebSocketSession.class);
        AtomicBoolean open = new AtomicBoolean(true);
        when(socket.getId()).thenReturn(id);
        when(socket.getAttributes()).thenReturn(Map.of(LocationRelay.IDENTITY, identity));
        when(socket.isOpen()).thenAnswer(invocation -> open.get());
        doAnswer(invocation -> { open.set(false); return null; }).when(socket).close(any());
        doAnswer(invocation -> {
            WebSocketMessage<?> message = invocation.getArgument(0);
            if (message instanceof TextMessage text) {
                String type = json.readTree(text.getPayload()).path("type").asText();
                events.add(type);
                if (type.equals("ready") && readyStarted != null) {
                    readyStarted.countDown();
                    if (!readyRelease.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test handshake did not resume");
                }
            }
            return null;
        }).when(socket).sendMessage(any());
        return socket;
    }

    @Test void concurrentStopCannotBeOvertakenByAnInitialPositionSnapshot() throws Exception {
        Store store = mock(Store.class);
        when(store.sessionActive(any())).thenReturn(true);
        LocationRelay relay = new LocationRelay(store, json, Clock.systemUTC());
        var executor = Executors.newFixedThreadPool(2);
        CountDownLatch readyStarted = new CountDownLatch(1);
        CountDownLatch readyRelease = new CountDownLatch(1);
        try {
            Store.SessionIdentity identity = new Store.SessionIdentity("same-account", "session-hash", System.currentTimeMillis() + 60_000);
            relay.connect(socket("publisher", identity, new CopyOnWriteArrayList<>(), null, null));
            relay.receive("publisher", new TextMessage(json.writeValueAsString(Map.of("type", "position", "latitude", 37.5,
                    "longitude", 127.1, "accuracy_m", 8, "observed_at", Instant.now().toString()))));
            List<String> events = new CopyOnWriteArrayList<>();
            WebSocketSession receiver = socket("receiver", identity, events, readyStarted, readyRelease);
            var connecting = executor.submit(() -> relay.connect(receiver));
            assertThat(readyStarted.await(5, TimeUnit.SECONDS)).isTrue();
            var stopping = executor.submit(() -> relay.receive("publisher", new TextMessage("{\"type\":\"stop\"}")));
            assertThrows(TimeoutException.class, () -> stopping.get(150, TimeUnit.MILLISECONDS));
            readyRelease.countDown();
            connecting.get(5, TimeUnit.SECONDS);
            stopping.get(5, TimeUnit.SECONDS);
            assertThat(events).containsExactly("ready", "position", "stopped");
        } finally {
            readyRelease.countDown();
            executor.shutdownNow();
            relay.stop();
        }
    }
}
