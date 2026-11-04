package com.drivemate.api;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;

@RestController
@RequestMapping("/api/v1/location")
public class LocationController {
    private final Auth auth;
    private final LocationOrigin origins;
    private final LocationRelay relay;

    public LocationController(Auth auth, LocationOrigin origins, LocationRelay relay) {
        this.auth = auth;
        this.origins = origins;
        this.relay = relay;
    }

    @PostMapping("/ticket")
    public Map<String, String> ticket(HttpServletRequest request) {
        Store.SessionIdentity identity = auth.requireSession(request);
        String origin = origins.require(request.getHeader("Origin"), ServletUriComponentsBuilder.fromRequest(request).build().toUri());
        return relay.issueTicket(identity, origin);
    }
}
