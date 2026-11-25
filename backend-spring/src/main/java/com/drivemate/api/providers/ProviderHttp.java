package com.drivemate.api.providers;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.SocketAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

@Component
public class ProviderHttp {
    public record Reply(int status, byte[] body, String retryAfter) {}
    @FunctionalInterface public interface Transport { Reply send(HttpRequest request) throws IOException, InterruptedException; }
    private static final int LIMIT = 2_000_000;
    private static final Set<String> HOSTS = Set.of("dapi.kakao.com", "apis-navi.kakaomobility.com", "www.googleapis.com", "oauth2.googleapis.com", "dev.kr-ccapi.hyundai.com");
    private final ObjectMapper mapper;
    private final Transport transport;
    private final boolean testTransport;
    @Autowired public ProviderHttp(ObjectMapper mapper) {
        this.mapper = mapper; this.testTransport = false;
        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER)
            .proxy(new ProxySelector() {
                @Override public List<Proxy> select(URI uri) { return List.of(Proxy.NO_PROXY); }
                @Override public void connectFailed(URI uri, SocketAddress address, IOException error) {}
            }).build();
        this.transport = request -> {
            CompletableFuture<HttpResponse<byte[]>> pending = client.sendAsync(request, info -> new BoundedBody());
            try {
                HttpResponse<byte[]> response = pending.get(10, TimeUnit.SECONDS);
                return new Reply(response.statusCode(), response.body(), response.headers().firstValue("Retry-After").orElse(null));
            } catch (TimeoutException error) {
                pending.cancel(true);
                throw new HttpTimeoutException("Provider response deadline exceeded");
            } catch (InterruptedException error) {
                pending.cancel(true);
                throw error;
            } catch (ExecutionException error) {
                if (error.getCause() instanceof ProviderException safe) throw safe;
                if (error.getCause() instanceof HttpTimeoutException) throw new HttpTimeoutException("Provider response deadline exceeded");
                throw new IOException("Provider transport failed");
            }
        };
    }

    /** Bound both the complete response duration and memory before accepting a provider body. */
    private static final class BoundedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> complete = new CompletableFuture<>();
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        private Flow.Subscription subscription;
        @Override public CompletionStage<byte[]> getBody() { return complete; }
        @Override public void onSubscribe(Flow.Subscription value) { subscription = value; value.request(1); }
        @Override public void onNext(List<ByteBuffer> buffers) {
            for (ByteBuffer buffer : buffers) {
                if (buffer.remaining() > LIMIT - bytes.size()) {
                    subscription.cancel(); complete.completeExceptionally(ProviderSupport.malformed()); return;
                }
                byte[] chunk = new byte[buffer.remaining()]; buffer.get(chunk); bytes.writeBytes(chunk);
            }
            subscription.request(1);
        }
        @Override public void onError(Throwable error) { complete.completeExceptionally(error); }
        @Override public void onComplete() { complete.complete(bytes.toByteArray()); }
    }
    public ProviderHttp(ObjectMapper mapper, Transport transport) { this.mapper = mapper; this.transport = transport; this.testTransport = true; }
    public boolean isTestTransport() { return testTransport; }
    public static String encode(String value) { return URLEncoder.encode(value, StandardCharsets.UTF_8); }
    public static String form(Map<String, String> fields) {
        return fields.entrySet().stream().map(e -> encode(e.getKey()) + "=" + encode(e.getValue())).collect(java.util.stream.Collectors.joining("&"));
    }
    public JsonNode get(String base, Map<String, String> params, String authorization) {
        HttpRequest.Builder request = request(URI.create(base + (params.isEmpty() ? "" : "?" + form(params)))).GET();
        if (authorization != null) request.header("Authorization", authorization);
        Reply reply = send(request.build()); checkStatus(reply);
        JsonNode data = parse(reply, false);
        for (String key : List.of("error", "errors", "errCode", "errMsg", "errId")) {
            if (data.has(key)) throw new ProviderException("provider_rejected", "외부 서비스가 요청을 거부했습니다.", 502);
        }
        return data;
    }
    public JsonNode oauthPost(String endpoint, Map<String, String> fields, boolean allowEmpty) {
        if (!Set.of("https://oauth2.googleapis.com/token", "https://oauth2.googleapis.com/revoke").contains(endpoint)) throw new IllegalArgumentException("OAuth endpoint is not allowed");
        Reply reply = send(request(URI.create(endpoint)).header("Content-Type", "application/x-www-form-urlencoded")
            .POST(HttpRequest.BodyPublishers.ofString(form(fields))).build());
        if (reply.status() == 429 || reply.status() >= 500) checkStatus(reply);
        if (reply.body().length > 128_000) throw ProviderSupport.malformed();
        JsonNode data = parse(reply, allowEmpty); String error = data.path("error").asText();
        if (Set.of("invalid_grant", "access_denied", "invalid_token").contains(error)) throw new ProviderException("oauth_reauthorization_required", "Google 캘린더 연결 동의가 다시 필요합니다.", 401);
        if (Set.of("invalid_client", "unauthorized_client", "redirect_uri_mismatch").contains(error)) throw new ProviderException("oauth_not_configured", "Google 캘린더 OAuth 서버 설정을 확인해 주세요.", 503);
        if (reply.status() != 200 || data.has("error")) throw new ProviderException("provider_rejected", "Google 연결 요청을 완료하지 못했습니다.", 502);
        return data;
    }
    private HttpRequest.Builder request(URI uri) {
        if (!"https".equals(uri.getScheme()) || !HOSTS.contains(uri.getHost()) || uri.getUserInfo() != null || uri.getFragment() != null || (uri.getPort() != -1 && uri.getPort() != 443)) throw new IllegalArgumentException("Provider endpoint is not allowed");
        return HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(10)).header("Accept", "application/json");
    }
    private Reply send(HttpRequest request) {
        try {
            Reply result = transport.send(request);
            if (result.body().length > LIMIT) throw ProviderSupport.malformed();
            return result;
        } catch (HttpTimeoutException error) {
            throw new ProviderException("provider_timeout", "외부 서비스 응답 시간이 초과되었습니다.", 504, true, null, null);
        } catch (IOException error) {
            throw new ProviderException("provider_unavailable", "외부 서비스에 연결할 수 없습니다.", 502, true, null, null);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new ProviderException("provider_unavailable", "외부 서비스 요청이 중단되었습니다.", 502, true, null, null);
        }
    }
    private JsonNode parse(Reply reply, boolean allowEmpty) {
        if (allowEmpty && reply.body().length == 0) return mapper.createObjectNode();
        try {
            JsonNode data = mapper.readTree(reply.body());
            if (data == null || !data.isObject()) throw ProviderSupport.malformed();
            return data;
        } catch (IOException error) { throw ProviderSupport.malformed(); }
    }
    private void checkStatus(Reply reply) {
        int status = reply.status();
        if (status == 429) {
            Double retry = null;
            try { double value = Double.parseDouble(reply.retryAfter()); if (Double.isFinite(value) && value >= 0) retry = Math.min(120, value); }
            catch (NullPointerException | NumberFormatException ignored) { /* Invalid header is omitted. */ }
            throw new ProviderException("provider_rate_limited", "외부 서비스 요청 한도를 초과했습니다.", 429, true, null, retry);
        }
        if (status == 401 || status == 403) throw new ProviderException("provider_authorization_required", "외부 서비스 연결 권한을 다시 확인해 주세요.", 503, false, status, null);
        if (status < 200 || status >= 300) throw new ProviderException("provider_http_error", "외부 서비스가 정상 응답을 반환하지 않았습니다.", 502, status >= 500, status, null);
    }
}

