package com.drivemate.api;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class RegistrationPolicy {
    private final Set<String> reservedEmails;
    private final byte[] bootstrapToken;

    public RegistrationPolicy(
            @Value("${DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS:}") String allowedEmails,
            @Value("${DRIVEMATE_BOOTSTRAP_TOKEN:}") String bootstrapToken) {
        this.reservedEmails = Arrays.stream(allowedEmails.split(",")).map(String::strip)
                .map(email -> email.toLowerCase(Locale.ROOT)).filter(email -> !email.isEmpty())
                .collect(Collectors.toUnmodifiableSet());
        this.bootstrapToken = bootstrapToken.getBytes(StandardCharsets.UTF_8);
    }

    public void require(String email, String suppliedToken) {
        if (!reservedEmails.contains(email)) return;
        // A privileged email stays reserved even after its account is deleted.
        if (bootstrapToken.length >= 32 && suppliedToken != null && suppliedToken.length() <= 256
                && MessageDigest.isEqual(bootstrapToken, suppliedToken.getBytes(StandardCharsets.UTF_8))) return;
        throw new ApiException("email_reserved", "이 이메일은 관리자가 계정을 준비해야 사용할 수 있어요.", 403);
    }
}
