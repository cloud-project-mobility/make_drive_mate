package com.drivemate.api;

import java.util.List;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PongMessage;
import org.springframework.web.socket.SubProtocolCapable;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@Component
public class LocationSocketHandler extends TextWebSocketHandler implements SubProtocolCapable {
    public static final String PROTOCOL = "drivemate.location.v1";
    private final LocationRelay relay;

    public LocationSocketHandler(LocationRelay relay) { this.relay = relay; }

    @Override public List<String> getSubProtocols() { return List.of(PROTOCOL); }
    @Override public void afterConnectionEstablished(WebSocketSession session) { relay.connect(session); }
    @Override protected void handleTextMessage(WebSocketSession session, TextMessage message) { relay.receive(session.getId(), message); }
    @Override protected void handlePongMessage(WebSocketSession session, PongMessage message) { relay.pong(session.getId()); }
    @Override public void afterConnectionClosed(WebSocketSession session, CloseStatus status) { relay.disconnected(session.getId()); }
    @Override public void handleTransportError(WebSocketSession session, Throwable exception) { relay.close(session.getId(), CloseStatus.SERVER_ERROR); }
}
