package com.drivemate.api.providers;

import static org.junit.jupiter.api.Assertions.*;
import com.drivemate.api.AppSettings;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

class HyundaiSampleProviderTest {
    private final ObjectMapper json = new ObjectMapper();
    private final String carId = "00000000-0000-0000-0000-000000000001";
    private MockEnvironment configured() {
        return new MockEnvironment().withProperty("DRIVEMATE_HYUNDAI_SAMPLE_ENABLED", "true")
                .withProperty("HYUNDAI_SAMPLE_TOKEN", "fixture-token")
                .withProperty("HYUNDAI_SAMPLE_CAR_ID", carId);
    }
    private HyundaiSampleProvider provider(MockEnvironment env, String mode, ProviderHttp.Transport transport) {
        return new HyundaiSampleProvider(env, new AppSettings(mode, 12, "http://localhost"), new ProviderHttp(json, transport));
    }
    private ProviderHttp.Reply sample() {
        return new ProviderHttp.Reply(200, ("{\"msgId\":\"fixture\",\"odometers\":[{\"date\":\"20261028\","
                + "\"timestamp\":\"20261028090000\",\"value\":1000,\"unit\":3}]}")
                .getBytes(java.nio.charset.StandardCharsets.UTF_8), null);
    }
    @Test void sendsOnlySampleBearerToFixedEndpointAndKeepsProvenance() {
        Map<String, Object> result = provider(configured(), "mock", request -> {
            assertEquals("https", request.uri().getScheme());
            assertEquals("dev.kr-ccapi.hyundai.com", request.uri().getHost());
            assertEquals("/api_sample/v1/car/status/" + carId + "/odometer", request.uri().getPath());
            assertEquals("Bearer fixture-token", request.headers().firstValue("Authorization").orElseThrow());
            assertEquals("GET", request.method());
            return sample();
        }).fetch("EV");
        assertEquals(1609.344, result.get("odometer_km"));
        assertEquals("hyundai_sample", result.get("source"));
        assertEquals(true, result.get("is_sample"));
        assertEquals(false, result.get("transport_verified"));
        assertNull(result.get("observed_at"));
        assertFalse(result.containsKey("battery_percent"));
        assertFalse(result.toString().contains(carId));
        assertFalse(result.toString().contains("fixture-token"));
    }
    @Test void missingDisabledAndMalformedConfigurationNeverCallsNetwork() {
        ProviderHttp.Transport forbidden = request -> { throw new AssertionError("Unexpected request"); };
        assertThrows(ProviderException.class, () -> provider(new MockEnvironment(), "mock", forbidden).fetch("EV"));
        assertThrows(ProviderException.class, () -> provider(configured(), "disconnected", forbidden).fetch("EV"));
        for (String name : new String[]{"HYUNDAI_SAMPLE_TOKEN", "HYUNDAI_SAMPLE_CAR_ID"}) {
            assertThrows(ProviderException.class, () -> provider(configured().withProperty(name, "invalid\nheader"), "mock", forbidden).fetch("EV"));
            assertThrows(ProviderException.class, () -> provider(configured().withProperty(name, ""), "mock", forbidden).fetch("EV"));
        }
        assertThrows(IllegalArgumentException.class, () -> provider(configured(), "mock", forbidden).fetch("OTHER"));
    }
    @Test void failuresNeverReturnMockAndAreNotRetried() {
        AtomicInteger calls = new AtomicInteger();
        var provider = provider(configured(), "mock", request -> {
            calls.incrementAndGet();
            return new ProviderHttp.Reply(401, new byte[0], null);
        });
        assertThrows(ProviderException.class, () -> provider.fetch("ICE"));
        assertEquals(1, calls.get());
        assertThrows(ProviderException.class, () -> provider(configured(), "mock",
                request -> new ProviderHttp.Reply(200, "{}".getBytes(), null)).fetch("EV"));
        assertThrows(ProviderException.class, () -> provider(configured(), "mock",
                request -> { throw new java.io.IOException("sensitive upstream diagnostic"); }).fetch("EV"));
    }
}
