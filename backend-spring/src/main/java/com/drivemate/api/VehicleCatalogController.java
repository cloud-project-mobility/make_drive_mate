package com.drivemate.api;

import java.time.Duration;
import java.util.Map;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/vehicle-catalog")
public class VehicleCatalogController {
    private final VehicleCatalogService catalog;

    public VehicleCatalogController(VehicleCatalogService catalog) { this.catalog = catalog; }

    @GetMapping
    public Map<String, Object> list(@RequestParam(defaultValue = "") String query,
            @RequestParam(defaultValue = "") String manufacturer, @RequestParam(defaultValue = "100") int limit) {
        return catalog.list(query, manufacturer, limit);
    }

    @GetMapping("/{id}")
    public VehicleCatalogEntry find(@PathVariable String id) { return catalog.find(id); }

    @GetMapping("/{id}/image")
    public ResponseEntity<Resource> image(@PathVariable String id) {
        VehicleCatalogEntry entry = catalog.find(id);
        Resource resource = catalog.image(entry);
        return ResponseEntity.ok().contentType(catalog.imageType(entry))
                .cacheControl(CacheControl.maxAge(Duration.ofHours(1)).cachePublic()).body(resource);
    }
}
