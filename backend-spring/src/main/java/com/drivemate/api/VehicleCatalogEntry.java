package com.drivemate.api;

import java.util.List;

public record VehicleCatalogEntry(
        String id,
        String manufacturer,
        String model,
        String generation,
        int yearFrom,
        Integer yearTo,
        List<String> powertrains,
        String imageUrl,
        String imageObjectKey,
        String imageSourceUrl,
        String imageAuthor,
        String imageLicense,
        String imageLicenseUrl,
        boolean representative,
        String note) {
}
