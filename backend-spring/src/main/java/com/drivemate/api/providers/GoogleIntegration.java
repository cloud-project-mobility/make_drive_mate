package com.drivemate.api.providers;

import static com.drivemate.api.providers.ProviderSupport.map;
import com.drivemate.api.AccountDisconnect;
import com.drivemate.api.ApiException;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.locks.ReentrantLock;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Per-account OAuth state and encrypted tokens. Run one instance until distributed refresh leasing. */
@Service
@DependsOnDatabaseInitialization
public class GoogleIntegration implements AccountDisconnect {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final ProviderSettings settings;
    private final GoogleOAuthClient oauth;
    private final GoogleCalendarProvider calendar;
    private final ObjectMapper mapper;
    private final SecureRandom random = new SecureRandom();
    private final ReentrantLock[] refreshLocks = new ReentrantLock[64];
    private final byte[] encryptionKey;
    private record Grant(long revision, String encrypted, GoogleOAuthClient.Tokens tokens) {}
    private record Pending(String userId, String verifier, long expiresAt) {}

    public GoogleIntegration(JdbcTemplate jdbc, PlatformTransactionManager manager, ProviderSettings settings,
            GoogleOAuthClient oauth, GoogleCalendarProvider calendar, ObjectMapper mapper) {
        this.jdbc = jdbc; this.transactions = new TransactionTemplate(manager); this.settings = settings;
        this.oauth = oauth; this.calendar = calendar; this.mapper = mapper;
        for (int i = 0; i < refreshLocks.length; i++) refreshLocks[i] = new ReentrantLock();
        byte[] key = null;
        if (!settings.encryptionKey().isEmpty()) {
            try { key = Base64.getUrlDecoder().decode(settings.encryptionKey()); }
            catch (IllegalArgumentException error) { throw new IllegalArgumentException("DRIVEMATE_TOKEN_ENCRYPTION_KEY must encode 32 random bytes"); }
            if (key.length != 32) throw new IllegalArgumentException("DRIVEMATE_TOKEN_ENCRYPTION_KEY must encode 32 random bytes");
        }
        this.encryptionKey = key;
    }
    @PostConstruct public void schema() {
        jdbc.execute("CREATE TABLE IF NOT EXISTS provider_tokens (user_id VARCHAR(100) PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, encrypted TEXT NOT NULL, revision BIGINT NOT NULL)");
        jdbc.execute("CREATE TABLE IF NOT EXISTS oauth_states (state_hash VARCHAR(64) PRIMARY KEY, user_id VARCHAR(100) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, verifier TEXT NOT NULL, expires_at BIGINT NOT NULL)");
    }
    public boolean configured() { return settings.mode().equals("live") && encryptionKey != null && oauth.configured(); }
    private void requireConfigured() {
        if (!configured()) throw new ApiException("oauth_not_configured", "Google 연결은 서버의 OAuth 설정 후 사용할 수 있어요.", 503);
    }
    public Map<String, Object> status(String uid) {
        boolean connected = !jdbc.queryForList("SELECT user_id FROM provider_tokens WHERE user_id = ?", uid).isEmpty();
        return map("configured", configured(), "connected", connected, "live_verified", false);
    }
    private String randomToken(int size) { byte[] bytes = new byte[size]; random.nextBytes(bytes); return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }
    private static String digest(String value) {
        try { return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (GeneralSecurityException error) { throw new IllegalStateException("SHA-256 unavailable"); }
    }
    private String encrypt(String plaintext, String owner) {
        requireConfigured();
        try {
            byte[] nonce = new byte[12]; random.nextBytes(nonce);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(encryptionKey, "AES"), new GCMParameterSpec(128, nonce));
            cipher.updateAAD(owner.getBytes(StandardCharsets.UTF_8)); byte[] encrypted = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return "v1:" + Base64.getUrlEncoder().encodeToString(ByteBuffer.allocate(nonce.length + encrypted.length).put(nonce).put(encrypted).array());
        } catch (GeneralSecurityException error) { throw new IllegalStateException("Token encryption unavailable"); }
    }
    private String decrypt(String value, String owner) {
        requireConfigured();
        try {
            if (!value.startsWith("v1:")) throw new GeneralSecurityException();
            byte[] bytes = Base64.getUrlDecoder().decode(value.substring(3));
            if (bytes.length < 29) throw new GeneralSecurityException();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(encryptionKey, "AES"), new GCMParameterSpec(128, bytes, 0, 12));
            cipher.updateAAD(owner.getBytes(StandardCharsets.UTF_8));
            return new String(cipher.doFinal(bytes, 12, bytes.length - 12), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | IllegalArgumentException error) {
            throw new ApiException("provider_reconnect_required", "Google 연결 정보를 읽을 수 없어 다시 연결해야 해요.", 503);
        }
    }
    private String encode(GoogleOAuthClient.Tokens tokens, String uid) {
        try { return encrypt(mapper.writeValueAsString(tokens), "tokens:" + uid); }
        catch (java.io.IOException error) { throw new IllegalStateException("Token serialization failed"); }
    }
    private GoogleOAuthClient.Tokens decode(String encrypted, String uid) {
        try { return mapper.readValue(decrypt(encrypted, "tokens:" + uid), GoogleOAuthClient.Tokens.class); }
        catch (java.io.IOException error) { throw new ApiException("provider_reconnect_required", "Google 연결 정보를 읽을 수 없어 다시 연결해야 해요.", 503); }
    }
    public Map<String, Object> authorize(String uid) {
        requireConfigured(); String state = randomToken(32), verifier = randomToken(64), challenge;
        try { challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII))); }
        catch (GeneralSecurityException error) { throw new IllegalStateException("SHA-256 unavailable"); }
        String url = oauth.authorizationUrl(state, challenge), hash = digest(state);
        transactions.executeWithoutResult(status -> {
            jdbc.update("DELETE FROM oauth_states WHERE user_id = ? OR expires_at <= ?", uid, Instant.now().getEpochSecond());
            jdbc.update("INSERT INTO oauth_states(state_hash,user_id,verifier,expires_at) VALUES (?,?,?,?)", hash, uid,
                encrypt(verifier, "state:" + hash + ":" + uid), Instant.now().plusSeconds(600).getEpochSecond());
        });
        return map("authorization_url", url, "expires_in", 600);
    }
    public void callback(String state, String code, String error) {
        requireConfigured();
        if (state == null || !state.matches("[A-Za-z0-9_-]{32,256}")) throw invalidState();
        String hash = digest(state);
        Pending pending = transactions.execute(status -> {
            List<Pending> rows = jdbc.query("SELECT user_id,verifier,expires_at FROM oauth_states WHERE state_hash = ?", (rs, index) -> new Pending(rs.getString(1), rs.getString(2), rs.getLong(3)), hash);
            if (rows.isEmpty()) return null;
            Pending item = rows.get(0);
            int claimed = jdbc.update("UPDATE oauth_states SET verifier = '' WHERE state_hash = ? AND verifier = ? AND verifier <> ''", hash, item.verifier());
            return claimed == 1 ? item : null;
        });
        if (pending == null || pending.expiresAt() <= Instant.now().getEpochSecond()) throw invalidState();
        if (error != null || code == null || code.isBlank()) throw new ApiException("oauth_denied", "Google 연결이 승인되지 않았어요. 앱에서 다시 시도할 수 있어요.", 400);
        GoogleOAuthClient.Tokens tokens;
        try { tokens = oauth.exchange(code, decrypt(pending.verifier(), "state:" + hash + ":" + pending.userId())); }
        catch (IllegalArgumentException exception) { throw new ApiException("invalid_oauth_callback", "Google 인증 응답을 확인할 수 없어요.", 422); }
        if (tokens.refreshToken() == null) throw new ApiException("oauth_refresh_missing", "지속적인 일정 조회를 위해 Google 연결 동의를 다시 진행해 주세요.", 409);
        transactions.executeWithoutResult(status -> {
            // Claim/remove in the final transaction. Disconnect/new consent can invalidate an exchange in flight.
            if (jdbc.update("DELETE FROM oauth_states WHERE state_hash = ? AND user_id = ? AND verifier = ''", hash, pending.userId()) != 1) throw changed();
            if (jdbc.queryForList("SELECT id FROM accounts WHERE id = ?", pending.userId()).isEmpty()) throw new ApiException("account_removed", "삭제된 계정에는 연결할 수 없어요.", 409);
            String encrypted = encode(tokens, pending.userId());
            if (jdbc.update("UPDATE provider_tokens SET encrypted = ?, revision = revision + 1 WHERE user_id = ?", encrypted, pending.userId()) == 0)
                jdbc.update("INSERT INTO provider_tokens(user_id,encrypted,revision) VALUES (?,?,1)", pending.userId(), encrypted);
        });
    }
    private static ApiException invalidState() { return new ApiException("invalid_oauth_state", "연결 요청이 만료되었거나 이미 사용됐어요. 앱에서 다시 연결해 주세요.", 400); }
    private static ApiException changed() { return new ApiException("google_connection_changed", "Google 연결이 변경됐어요. 다시 조회해 주세요.", 409); }
    private Grant loadGrant(String uid) {
        List<Grant> grants = jdbc.query("SELECT revision,encrypted FROM provider_tokens WHERE user_id = ?", (rs, index) -> {
            String encrypted = rs.getString(2); return new Grant(rs.getLong(1), encrypted, decode(encrypted, uid));
        }, uid);
        if (grants.isEmpty()) throw new ApiException("google_not_connected", "먼저 Google Calendar 연결에 동의해 주세요.", 409);
        return grants.get(0);
    }
    private void discard(String uid, Grant grant) { jdbc.update("DELETE FROM provider_tokens WHERE user_id = ? AND revision = ? AND encrypted = ?", uid, grant.revision(), grant.encrypted()); }
    private boolean current(String uid, Grant grant) { return !jdbc.queryForList("SELECT user_id FROM provider_tokens WHERE user_id = ? AND revision = ? AND encrypted = ?", uid, grant.revision(), grant.encrypted()).isEmpty(); }
    private boolean needsRefresh(Grant grant, Grant rejected) {
        return !Instant.parse(grant.tokens().expiresAt()).isAfter(Instant.now().plusSeconds(60))
            || rejected != null && rejected.revision() == grant.revision() && rejected.encrypted().equals(grant.encrypted());
    }
    private Grant credentials(String uid, Grant rejected) {
        requireConfigured(); Grant initial = loadGrant(uid); if (!needsRefresh(initial, rejected)) return initial;
        ReentrantLock lock = refreshLocks[Math.floorMod(uid.hashCode(), refreshLocks.length)]; lock.lock();
        try {
            Grant grant = loadGrant(uid); if (!needsRefresh(grant, rejected)) return grant;
            GoogleOAuthClient.Tokens old = grant.tokens();
            if (old.refreshExpiresAt() != null && !Instant.parse(old.refreshExpiresAt()).isAfter(Instant.now())) {
                discard(uid, grant); throw new ProviderException("oauth_reauthorization_required", "Google 연결 동의가 만료됐어요. 다시 연결해 주세요.", 409);
            }
            GoogleOAuthClient.Tokens fresh;
            try { fresh = oauth.refresh(old.refreshToken()); }
            catch (ProviderException error) { if (error.code().equals("oauth_reauthorization_required")) discard(uid, grant); throw error; }
            String refresh = fresh.refreshToken() == null ? old.refreshToken() : fresh.refreshToken();
            String expiry = fresh.refreshExpiresAt();
            if (refresh.equals(old.refreshToken()) && expiry == null) expiry = old.refreshExpiresAt();
            GoogleOAuthClient.Tokens merged = new GoogleOAuthClient.Tokens(fresh.accessToken(), refresh, fresh.expiresAt(), expiry);
            String encrypted = encode(merged, uid);
            if (jdbc.update("UPDATE provider_tokens SET encrypted = ?, revision = revision + 1 WHERE user_id = ? AND revision = ? AND encrypted = ?", encrypted, uid, grant.revision(), grant.encrypted()) != 1) throw changed();
            return new Grant(grant.revision() + 1, encrypted, merged);
        } finally { lock.unlock(); }
    }
    public Map<String, Object> listEvents(String uid, OffsetDateTime minimum, OffsetDateTime maximum) {
        Grant grant = credentials(uid, null);
        for (int attempt = 0; attempt < 2; attempt++) {
            Map<String, Object> result;
            try { result = calendar.listEvents("live", grant.tokens().accessToken(), minimum, maximum); }
            catch (ProviderException error) {
                if (!Objects.equals(error.upstreamStatus(), 401)) throw error;
                if (attempt == 0) { grant = credentials(uid, grant); continue; }
                discard(uid, grant); throw new ProviderException("oauth_reauthorization_required", "Google 캘린더 연결 동의가 다시 필요합니다.", 401, false, 401, null);
            }
            if (!current(uid, grant)) throw changed(); return result;
        }
        throw new IllegalStateException("Unreachable refresh path");
    }
    public Map<String, Object> disconnect(String uid) {
        String encrypted = transactions.execute(status -> {
            List<String> tokens = jdbc.query("SELECT encrypted FROM provider_tokens WHERE user_id = ?", (rs, index) -> rs.getString(1), uid);
            jdbc.update("DELETE FROM provider_tokens WHERE user_id = ?", uid); jdbc.update("DELETE FROM oauth_states WHERE user_id = ?", uid);
            return tokens.isEmpty() ? null : tokens.get(0);
        });
        Boolean revoked = null;
        if (encrypted != null && configured()) {
            try { GoogleOAuthClient.Tokens tokens = decode(encrypted, uid); oauth.revoke(tokens.refreshToken() != null ? tokens.refreshToken() : tokens.accessToken()); revoked = true; }
            catch (ProviderException | ApiException exception) { revoked = false; }
        }
        return map("connected", false, "provider_revoked", revoked);
    }
    @Override public void disconnectAccount(String userId) { disconnect(userId); }
}
