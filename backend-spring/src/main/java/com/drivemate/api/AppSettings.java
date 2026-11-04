package com.drivemate.api;

import java.util.Arrays;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class AppSettings {
    private final String providerMode;
    private final int sessionHours;
    private final List<String> corsOrigins;

    public AppSettings(
            @Value("${DRIVEMATE_PROVIDER_MODE:mock}") String providerMode,
            @Value("${DRIVEMATE_SESSION_HOURS:12}") int sessionHours,
            @Value("${DRIVEMATE_CORS_ORIGINS:http://localhost:8081,http://127.0.0.1:8081,http://localhost:19006,http://127.0.0.1:19006}") String corsOrigins) {
        if (!List.of("mock", "disconnected", "live").contains(providerMode)) {
            throw new IllegalArgumentException("DRIVEMATE_PROVIDER_MODE must be mock, disconnected or live");
        }
        if (sessionHours < 1 || sessionHours > 168) {
            throw new IllegalArgumentException("DRIVEMATE_SESSION_HOURS must be 1..168");
        }
        this.providerMode = providerMode;
        this.sessionHours = sessionHours;
        this.corsOrigins = Arrays.stream(corsOrigins.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
        if (this.corsOrigins.contains("*")) {
            throw new IllegalArgumentException("DRIVEMATE_CORS_ORIGINS must name explicit origins");
        }
    }

    public String providerMode() { return providerMode; }
    public int sessionHours() { return sessionHours; }
    public List<String> corsOrigins() { return corsOrigins; }
}
