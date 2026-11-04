package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/vehicles")
public class VehicleRegistrationController {
    private final Auth auth;
    private final VehicleRegistrationService vehicles;

    public VehicleRegistrationController(Auth auth, VehicleRegistrationService vehicles) {
        this.auth = auth;
        this.vehicles = vehicles;
    }

    @GetMapping
    public Map<String, Object> list(HttpServletRequest request) {
        return Map.of("vehicles", vehicles.list((String) auth.require(request).get("id")));
    }

    @PutMapping("/{id}")
    public Map<String, Object> save(@PathVariable String id, @RequestBody JsonNode body, HttpServletRequest request) {
        return Map.of("vehicle", vehicles.save((String) auth.require(request).get("id"), id, body));
    }

    @DeleteMapping("/{id}")
    public Map<String, Boolean> delete(@PathVariable String id, HttpServletRequest request) {
        vehicles.delete((String) auth.require(request).get("id"), id);
        return Map.of("ok", true);
    }
}
