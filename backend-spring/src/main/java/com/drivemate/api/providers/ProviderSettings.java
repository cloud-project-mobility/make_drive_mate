package com.drivemate.api.providers;

import com.drivemate.api.AppSettings;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

@Component
public class ProviderSettings {
    private final AppSettings app;
    private final Environment environment;
    public ProviderSettings(AppSettings app, Environment environment) { this.app = app; this.environment = environment; }
    public String mode() { return app.providerMode(); }
    private String value(String name) { return mode().equals("live") ? environment.getProperty(name, "") : ""; }
    public String kakaoRestKey() { return value("DRIVEMATE_KAKAO_REST_KEY"); }
    public String kakaoMobilityKey() { String key = value("DRIVEMATE_KAKAO_MOBILITY_KEY"); return key.isEmpty() ? kakaoRestKey() : key; }
    public String googleClientId() { return value("DRIVEMATE_GOOGLE_CLIENT_ID"); }
    public String googleClientSecret() { return value("DRIVEMATE_GOOGLE_CLIENT_SECRET"); }
    public String googleRedirectUri() { return value("DRIVEMATE_GOOGLE_REDIRECT_URI"); }
    public String encryptionKey() { return value("DRIVEMATE_TOKEN_ENCRYPTION_KEY"); }
}
