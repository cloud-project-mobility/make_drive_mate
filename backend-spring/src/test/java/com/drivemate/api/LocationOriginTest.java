package com.drivemate.api;

import java.net.URI;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;

class LocationOriginTest {
    private final LocationOrigin origins = new LocationOrigin(new AppSettings("mock", 12, "http://localhost:8081"));

    @Test void acceptsExplicitLocalBrowserAndTrustedForwardedProductionOrigin() {
        assertThat(origins.require("http://localhost:8081", URI.create("http://localhost:18085/api/v1/location/stream")))
                .isEqualTo("http://localhost:8081");
        assertThat(origins.require("https://example.cloudfront.net", URI.create("https://example.cloudfront.net/api/v1/location/stream")))
                .isEqualTo("https://example.cloudfront.net:443");
    }

    @Test void deniesMissingNullMalformedOrDifferentOrigins() {
        for (String origin : new String[]{null, "null", "", "https://attacker.example", "https://example.cloudfront.net.attacker.example",
                "https://user@example.cloudfront.net", "https://example.cloudfront.net/path", "https://example.cloudfront.net?query=1"}) {
            assertThrows(ApiException.class, () -> origins.require(origin, URI.create("https://example.cloudfront.net/api/v1/location/stream")));
        }
    }
}
