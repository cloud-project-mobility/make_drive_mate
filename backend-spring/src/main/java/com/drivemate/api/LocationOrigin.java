package com.drivemate.api;

import java.net.URI;
import java.util.Locale;
import org.springframework.stereotype.Component;

/** Browser origins are checked independently of the one-use handshake credential. */
@Component
public class LocationOrigin {
    private final AppSettings settings;

    public LocationOrigin(AppSettings settings) { this.settings = settings; }

    public String require(String supplied, URI request) {
        String origin = normalize(supplied, true);
        if (origin == null || (!origin.equals(normalize(request.toString(), false))
                && settings.corsOrigins().stream().noneMatch(value -> origin.equals(normalize(value, true))))) {
            throw new ApiException("location_origin_denied", "허용된 웹 화면에서 위치 연결을 시작해 주세요.", 403);
        }
        return origin;
    }

    private static String normalize(String value, boolean originOnly) {
        if (value == null || value.isBlank() || value.length() > 512) return null;
        try {
            URI uri = URI.create(value);
            String scheme = uri.getScheme();
            if (scheme == null || !(scheme.equalsIgnoreCase("https") || scheme.equalsIgnoreCase("http"))
                    || uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null
                    || (originOnly && (uri.getQuery() != null || (uri.getRawPath() != null && !uri.getRawPath().isEmpty())))) return null;
            int port = uri.getPort();
            if (port == -1) port = scheme.equalsIgnoreCase("https") ? 443 : 80;
            return scheme.toLowerCase(Locale.ROOT) + "://" + uri.getHost().toLowerCase(Locale.ROOT) + ":" + port;
        } catch (IllegalArgumentException exception) {
            return null;
        }
    }
}
