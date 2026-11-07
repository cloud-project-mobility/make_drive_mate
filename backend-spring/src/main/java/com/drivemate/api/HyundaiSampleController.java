package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import java.util.Set;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/vehicles/hyundai-sample")
public class HyundaiSampleController {
    private final Auth auth;
    private final HyundaiSampleService samples;

    public HyundaiSampleController(Auth auth, HyundaiSampleService samples) {
        this.auth = auth;
        this.samples = samples;
    }

    @PostMapping
    public Map<String, Object> refresh(@RequestParam(name = "powertrain", required = false) String powertrain,
            @RequestBody(required = false) JsonNode body, HttpServletRequest request) {
        String userId = (String) auth.requireProvider(request).get("id");
        if (body != null || powertrain == null || !Set.of("ICE", "HYB", "EV").contains(powertrain)) throw ApiException.invalid();
        return samples.refresh(userId, powertrain);
    }

    @GetMapping
    public Map<String, Object> get(HttpServletRequest request) {
        return samples.get((String) auth.require(request).get("id"));
    }
}
