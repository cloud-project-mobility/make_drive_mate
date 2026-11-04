package com.drivemate.api;

import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

@Component
public class LocationHandshake implements HandshakeInterceptor {
    private final LocationOrigin origins;
    private final LocationRelay relay;

    public LocationHandshake(LocationOrigin origins, LocationRelay relay) {
        this.origins = origins;
        this.relay = relay;
    }

    @Override public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
            WebSocketHandler handler, Map<String, Object> attributes) {
        try {
            String origin = origins.require(request.getHeaders().getOrigin(), request.getURI());
            if (request.getURI().getRawQuery() != null) {
                response.setStatusCode(HttpStatus.BAD_REQUEST);
                return false;
            }
            List<String> values = request.getHeaders().get("Sec-WebSocket-Protocol");
            String header = values == null ? "" : String.join(",", values);
            if (header.length() > 128) {
                response.setStatusCode(HttpStatus.UNAUTHORIZED);
                return false;
            }
            List<String> protocols = Arrays.stream(header.split(",")).map(String::trim).toList();
            if (protocols.size() != 2 || !protocols.contains(LocationSocketHandler.PROTOCOL)) {
                response.setStatusCode(HttpStatus.UNAUTHORIZED);
                return false;
            }
            String ticket = protocols.stream().filter(value -> value.matches("ticket\\.[A-Za-z0-9_-]{43}"))
                    .findFirst().orElse("");
            if (ticket.isEmpty()) {
                response.setStatusCode(HttpStatus.UNAUTHORIZED);
                return false;
            }
            attributes.put(LocationRelay.IDENTITY, relay.consumeTicket(ticket.substring(7), origin));
            return true;
        } catch (ApiException exception) {
            response.setStatusCode(HttpStatus.valueOf(exception.status()));
            return false;
        }
    }

    @Override public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
            WebSocketHandler handler, Exception exception) { }
}
