package com.drivemate.api;

import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class LocationWebSocketConfiguration implements WebSocketConfigurer {
    private final LocationSocketHandler handler;
    private final LocationHandshake handshake;
    private final AppSettings settings;

    public LocationWebSocketConfiguration(LocationSocketHandler handler, LocationHandshake handshake, AppSettings settings) {
        this.handler = handler;
        this.handshake = handshake;
        this.settings = settings;
    }

    @Override public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/api/v1/location/stream").addInterceptors(handshake)
                .setAllowedOrigins(settings.corsOrigins().toArray(String[]::new));
    }

    @Bean public static Clock locationClock() { return Clock.systemUTC(); }

}
