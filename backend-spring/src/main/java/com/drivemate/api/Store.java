package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class Store {
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int PASSWORD_ITERATIONS = 600_000;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final ObjectMapper json;
    private final AppSettings settings;
    private final AtomicLong lastRateCleanup = new AtomicLong();

    public Store(JdbcTemplate jdbc, TransactionTemplate transactions, ObjectMapper json, AppSettings settings) {
        this.jdbc = jdbc;
        this.transactions = transactions;
        this.json = json;
        this.settings = settings;
    }

    public void health() { jdbc.queryForObject("SELECT COUNT(*) FROM accounts", Long.class); }

    public static String digest(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    private static String random(int bytes) {
        byte[] data = new byte[bytes];
        RANDOM.nextBytes(data);
        return HexFormat.of().formatHex(data);
    }

    private static String passwordHash(String password, String salt) {
        PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), HexFormat.of().parseHex(salt), PASSWORD_ITERATIONS, 256);
        try {
            return HexFormat.of().formatHex(SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded());
        } catch (GeneralSecurityException exception) {
            throw new IllegalStateException("Password hashing is unavailable", exception);
        } finally {
            spec.clearPassword();
        }
    }

    public Map<String, Object> register(String email, String password) {
        String userId = UUID.randomUUID().toString();
        String salt = random(16);
        String hash = passwordHash(password, salt);
        try {
            return transactions.execute(status -> {
                jdbc.update("INSERT INTO accounts (id,email,salt,password_hash,created_at) VALUES (?,?,?,?,?)",
                        userId, email, salt, hash, Instant.now().toString());
                return newSession(Map.of("id", userId, "email", email));
            });
        } catch (DuplicateKeyException exception) {
            throw new ApiException("email_exists", "이미 등록된 이메일이에요.", 409);
        }
    }

    public Map<String, Object> login(String email, String password) {
        return transactions.execute(status -> {
            // Serialize password verification/session creation with password rotation.
            List<Map<String, Object>> rows = jdbc.queryForList("SELECT * FROM accounts WHERE email = ? FOR UPDATE", email);
            Map<String, Object> row = rows.isEmpty() ? null : rows.get(0);
            String salt = row == null ? "00".repeat(16) : (String) row.get("salt");
            String expected = row == null ? "00".repeat(32) : (String) row.get("password_hash");
            if (!passwordMatches(password, salt, expected) || row == null) {
                throw new ApiException("invalid_credentials", "이메일 또는 비밀번호를 확인해 주세요.", 401);
            }
            return newSession(Map.of("id", row.get("id"), "email", row.get("email")));
        });
    }

    private static boolean passwordMatches(String password, String salt, String expected) {
        String actual = passwordHash(password, salt);
        return MessageDigest.isEqual(actual.getBytes(StandardCharsets.US_ASCII), expected.getBytes(StandardCharsets.US_ASCII));
    }

    public void changePassword(String userId, String currentPassword, String newPassword) {
        transactions.executeWithoutResult(status -> {
            List<Map<String, Object>> rows = jdbc.queryForList("SELECT salt,password_hash FROM accounts WHERE id=? FOR UPDATE", userId);
            if (rows.isEmpty()) throw new ApiException("unauthorized", "다시 로그인해 주세요.", 401);
            Map<String, Object> row = rows.get(0);
            if (!passwordMatches(currentPassword, (String) row.get("salt"), (String) row.get("password_hash"))) {
                throw new ApiException("invalid_current_password", "현재 비밀번호를 확인해 주세요.", 400);
            }
            String salt = random(16);
            jdbc.update("UPDATE accounts SET salt=?,password_hash=? WHERE id=?", salt, passwordHash(newPassword, salt), userId);
            jdbc.update("DELETE FROM sessions WHERE user_id=?", userId);
        });
    }

    private Map<String, Object> newSession(Map<String, Object> user) {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        Instant expires = Instant.now().plusSeconds(settings.sessionHours() * 3600L);
        jdbc.update("DELETE FROM sessions WHERE expires_at <= ?", System.currentTimeMillis());
        jdbc.update("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)",
                digest(token), user.get("id"), expires.toEpochMilli());
        return Map.of("access_token", token, "token_type", "bearer", "user", user, "expires_at", expires.toString());
    }

    public Map<String, Object> authenticate(String token) {
        List<Map<String, Object>> users = jdbc.queryForList(
                "SELECT a.id,a.email FROM accounts a JOIN sessions s ON a.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
                digest(token), System.currentTimeMillis());
        if (users.isEmpty()) {
            throw new ApiException("unauthorized", "로그인이 필요하거나 세션이 만료됐어요.", 401);
        }
        return users.get(0);
    }

    public void logout(String token) { jdbc.update("DELETE FROM sessions WHERE token_hash=?", digest(token)); }

    public record SessionIdentity(String userId, String tokenHash, long expiresAt) { }

    public SessionIdentity authenticateSession(String token) {
        String hash = digest(token);
        List<SessionIdentity> rows = jdbc.query(
                "SELECT user_id,expires_at FROM sessions WHERE token_hash=? AND expires_at>?",
                (row, index) -> new SessionIdentity(row.getString("user_id"), hash, row.getLong("expires_at")),
                hash, System.currentTimeMillis());
        if (rows.isEmpty()) throw new ApiException("unauthorized", "로그인이 필요하거나 세션이 만료됐어요.", 401);
        return rows.get(0);
    }

    public boolean sessionActive(SessionIdentity session) {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?",
                Integer.class, session.tokenHash(), session.userId(), System.currentTimeMillis());
        return count != null && count == 1;
    }

    public void deleteAccount(String userId) { jdbc.update("DELETE FROM accounts WHERE id=?", userId); }

    public Map<String, Object> state(String userId) {
        List<Map<String, Object>> rows = jdbc.queryForList("SELECT * FROM snapshots WHERE user_id=?", userId);
        if (rows.isEmpty()) {
            Map<String, Object> empty = new LinkedHashMap<>();
            empty.put("revision", 0);
            empty.put("state", null);
            empty.put("updated_at", null);
            return empty;
        }
        return snapshot(rows.get(0));
    }

    private Map<String, Object> snapshot(Map<String, Object> row) {
        try {
            return Map.of("revision", row.get("revision"), "state", json.readTree((String) row.get("body")),
                    "updated_at", row.get("updated_at"));
        } catch (Exception exception) {
            throw new IllegalStateException("Stored snapshot is invalid", exception);
        }
    }

    public Map<String, Object> saveState(String userId, long expected, JsonNode state) {
        String body = state.toString();
        if (body.getBytes(StandardCharsets.UTF_8).length > 5 * 1024 * 1024) {
            throw new ApiException("snapshot_too_large", "백업은 5 MB 이하여야 해요.", 413);
        }
        return transactions.execute(status -> {
            // Lock the account row so initial uploads and later revisions serialize across API instances.
            List<String> owners = jdbc.queryForList("SELECT id FROM accounts WHERE id=? FOR UPDATE", String.class, userId);
            if (owners.isEmpty()) throw new ApiException("unauthorized", "로그인이 필요해요.", 401);
            Map<String, Object> current = state(userId);
            if (state.equals(current.get("state"))) return current;
            long revision = ((Number) current.get("revision")).longValue();
            if (revision != expected) {
                throw new ApiException("revision_conflict", "서버에 더 새로운 백업이 있어요. 먼저 확인해 주세요.", 409);
            }
            String updated = Instant.now().toString();
            if (revision == 0) {
                jdbc.update("INSERT INTO snapshots (user_id,revision,body,updated_at) VALUES (?,?,?,?)", userId, 1, body, updated);
            } else {
                jdbc.update("UPDATE snapshots SET revision=?,body=?,updated_at=? WHERE user_id=?", revision + 1, body, updated, userId);
            }
            return Map.of("revision", revision + 1, "state", state, "updated_at", updated);
        });
    }

    public void rateLimit(String bucket, int limit, int windowSeconds) {
        long now = System.currentTimeMillis();
        long lastCleanup = lastRateCleanup.get();
        if (now - lastCleanup > 3_600_000 && lastRateCleanup.compareAndSet(lastCleanup, now)) {
            jdbc.update("DELETE FROM rate_limits WHERE reset_at<?", now - 3_600_000);
        }
        // Create outside the locking transaction: a concurrent insert can fail without poisoning PostgreSQL's transaction.
        try {
            jdbc.update("INSERT INTO rate_limits (bucket,attempts,reset_at) VALUES (?,0,?)",
                    bucket, System.currentTimeMillis() + windowSeconds * 1000L);
        } catch (DuplicateKeyException ignored) {
            // The existing bucket is locked below.
        }
        boolean allowed = Boolean.TRUE.equals(transactions.execute(status -> {
            Map<String, Object> row = jdbc.queryForMap("SELECT attempts,reset_at FROM rate_limits WHERE bucket=? FOR UPDATE", bucket);
            long current = System.currentTimeMillis();
            int attempts = ((Number) row.get("attempts")).intValue();
            long reset = ((Number) row.get("reset_at")).longValue();
            if (reset <= current) {
                attempts = 0;
                reset = current + windowSeconds * 1000L;
            }
            if (attempts >= limit) return false;
            jdbc.update("UPDATE rate_limits SET attempts=?,reset_at=? WHERE bucket=?", attempts + 1, reset, bucket);
            return true;
        }));
        if (!allowed) throw new ApiException("rate_limited", "요청이 많아요. 잠시 후 다시 시도해 주세요.", 429);
    }
}
