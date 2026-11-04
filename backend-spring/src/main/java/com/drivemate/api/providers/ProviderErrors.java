package com.drivemate.api.providers;

import static com.drivemate.api.providers.ProviderSupport.map;
import java.util.Map;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice(assignableTypes = ProviderController.class)
@Order(Ordered.HIGHEST_PRECEDENCE)
public class ProviderErrors {
    @ExceptionHandler(ProviderException.class)
    public ResponseEntity<Map<String, Object>> providerError(ProviderException error) {
        Map<String, Object> detail = map("code", error.code(), "message", error.getMessage(), "retryable", error.retryable());
        if (error.retryAfter() != null) detail.put("retry_after_s", error.retryAfter());
        return ResponseEntity.status(error.status()).header("Cache-Control", "no-store").body(map("error", detail));
    }
}
