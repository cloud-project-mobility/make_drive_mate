package com.drivemate.api.providers;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.Map;

final class ProviderSupport {
    private ProviderSupport() {}
    static Map<String, Object> map(Object... values) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int i = 0; i < values.length; i += 2) result.put((String) values[i], values[i + 1]);
        return result;
    }
    static Map<String, Object> metadata(String provider, String mode, boolean test) {
        boolean mock = mode.equals("mock") || test;
        return map("source", mock ? "mock" : "live", "provider", provider, "is_mock", mock, "mode", mode);
    }
    static void enabled(String mode) {
        if (mode.equals("disconnected")) throw new ProviderException("provider_disconnected", "외부 서비스가 연결되지 않았습니다.", 503);
    }
    static String secret(String value, int maximum) {
        if (value == null || value.isEmpty() || value.length() > maximum || value.chars().anyMatch(c -> c < 33 || c > 126))
            throw new IllegalArgumentException("Invalid provider credential format");
        return value;
    }
    static String credential(String mode, String value) {
        enabled(mode);
        if (mode.equals("mock")) return null;
        try { return secret(value, 16384); }
        catch (IllegalArgumentException error) { throw new ProviderException("provider_not_configured", "외부 서비스 인증 설정이 필요합니다.", 503); }
    }
    static String text(JsonNode value, int maximum, boolean empty) {
        if (value == null || !value.isTextual() || value.asText().length() > maximum) throw new IllegalArgumentException("Invalid provider text");
        String text = value.asText().trim();
        if (!empty && text.isEmpty()) throw new IllegalArgumentException("Missing provider text");
        return text;
    }
    static long integer(JsonNode value) {
        if (value == null || !value.isIntegralNumber() || !value.canConvertToLong() || value.asLong() < 0) throw new IllegalArgumentException("Invalid provider integer");
        return value.asLong();
    }
    static double number(JsonNode value, boolean allowString) {
        if (value == null || (!value.isNumber() && !(allowString && value.isTextual()))) throw new IllegalArgumentException("Invalid provider number");
        double number = Double.parseDouble(value.asText());
        if (!Double.isFinite(number)) throw new IllegalArgumentException("Invalid provider number");
        return number;
    }
    static OffsetDateTime timestamp(String value) {
        if (value == null || !value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})")) throw new IllegalArgumentException("Offset-aware timestamp required");
        return OffsetDateTime.parse(value);
    }
    static ProviderException malformed() { return new ProviderException("provider_malformed_response", "외부 서비스 응답 형식을 확인할 수 없습니다.", 502); }
    static String now() { return Instant.now().toString(); }
}
