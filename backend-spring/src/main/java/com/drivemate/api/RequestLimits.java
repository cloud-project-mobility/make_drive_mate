package com.drivemate.api;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestLimits extends OncePerRequestFilter {
    static final int LIMIT = 5 * 1024 * 1024 + 4096;

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        if (request.getContentLengthLong() > LIMIT) {
            tooLarge(response);
            return;
        }
        byte[] body = request.getInputStream().readNBytes(LIMIT + 1);
        if (body.length > LIMIT) {
            tooLarge(response);
            return;
        }
        ByteArrayInputStream bytes = new ByteArrayInputStream(body);
        chain.doFilter(new HttpServletRequestWrapper(request) {
            @Override
            public ServletInputStream getInputStream() {
                return new ServletInputStream() {
                    @Override public int read() { return bytes.read(); }
                    @Override public int read(byte[] buffer, int offset, int length) { return bytes.read(buffer, offset, length); }
                    @Override public boolean isFinished() { return bytes.available() == 0; }
                    @Override public boolean isReady() { return true; }
                    @Override public void setReadListener(ReadListener listener) { throw new UnsupportedOperationException("Synchronous requests only"); }
                };
            }
        }, response);
    }

    private static void tooLarge(HttpServletResponse response) throws IOException {
        response.setStatus(413);
        response.setContentType("application/json");
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.getWriter().write("{\"error\":{\"code\":\"body_too_large\",\"message\":\"요청 데이터가 너무 커요.\"}}");
    }
}
