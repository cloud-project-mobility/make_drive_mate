package com.drivemate.api;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.io.ClassPathResource;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class VehicleCatalogService implements ApplicationRunner {
    private static final String COLUMNS = "id,manufacturer,model,generation,year_from,year_to,powertrains,"
            + "image_object_key,image_source_url,image_author,image_license,image_license_url,representative,note";
    private static final String FILTER = " WHERE (?='' OR LOWER(manufacturer)=?)"
            + " AND (?='' OR LOWER(CONCAT(manufacturer,' ',model,' ',generation)) LIKE ? ESCAPE '!')";
    private static final Set<String> FIELDS = Set.of("id", "manufacturer", "model", "generation", "yearFrom",
            "yearTo", "powertrains", "imageObjectKey", "imageSourceUrl", "imageAuthor", "imageLicense",
            "imageLicenseUrl", "representative", "note");
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public VehicleCatalogService(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    @Override
    public void run(ApplicationArguments arguments) {
        seed();
    }

    // ApplicationRunner executes after Boot has applied schema.sql. Validate the complete
    // packaged catalog and images before updating metadata; never change account snapshots.
    void seed() {
        List<VehicleCatalogEntry> entries = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        try (var input = new ClassPathResource("vehicle-catalog/catalog.json").getInputStream()) {
            JsonNode root = json.readTree(input);
            if (root == null || !root.isArray() || root.isEmpty() || root.size() > 1000) invalidSeed();
            for (JsonNode row : root) {
                VehicleCatalogEntry entry = seedEntry(row);
                if (!ids.add(entry.id())) invalidSeed();
                validateImage(entry);
                entries.add(entry);
            }
        } catch (IOException | IllegalArgumentException exception) {
            throw new IllegalStateException("Vehicle catalog or its packaged images are missing or invalid.", exception);
        }
        for (VehicleCatalogEntry entry : entries) upsert(entry);
    }

    public Map<String, Object> list(String query, String manufacturer, int limit) {
        if (limit < 1 || limit > 100) throw ApiException.invalid();
        String search = filterText(query, 100);
        String maker = filterText(manufacturer, 80);
        String pattern = "%" + search.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%";
        List<VehicleCatalogEntry> entries = jdbc.query("SELECT " + COLUMNS + " FROM vehicle_catalog" + FILTER
                        + " ORDER BY manufacturer,model,year_from DESC,id LIMIT ?", this::entry,
                maker, maker, search, pattern, limit);
        Long total = jdbc.queryForObject("SELECT COUNT(*) FROM vehicle_catalog" + FILTER, Long.class,
                maker, maker, search, pattern);
        return Map.of("vehicles", entries, "total", total == null ? 0 : total);
    }

    public VehicleCatalogEntry find(String id) {
        if (id == null || !id.matches("[a-z0-9-]{1,80}")) throw notFound();
        List<VehicleCatalogEntry> entries = jdbc.query("SELECT " + COLUMNS + " FROM vehicle_catalog WHERE id=?",
                this::entry, id);
        if (entries.isEmpty()) throw notFound();
        return entries.get(0);
    }

    public ClassPathResource image(VehicleCatalogEntry entry) {
        String key = entry.imageObjectKey();
        if (!key.equals("data/vehicle-catalog/" + entry.id() + ".png")
                && !key.equals("data/vehicle-catalog/" + entry.id() + ".jpg")) throw notFound();
        ClassPathResource resource = new ClassPathResource("vehicle-catalog/images/" + key.substring("data/vehicle-catalog/".length()));
        if (!resource.exists()) throw notFound();
        return resource;
    }

    public MediaType imageType(VehicleCatalogEntry entry) {
        return entry.imageObjectKey().endsWith(".png") ? MediaType.IMAGE_PNG : MediaType.IMAGE_JPEG;
    }

    private VehicleCatalogEntry seedEntry(JsonNode row) {
        if (!row.isObject()) invalidSeed();
        Set<String> fields = new HashSet<>();
        row.fieldNames().forEachRemaining(fields::add);
        if (!fields.equals(FIELDS)) invalidSeed();
        String id = seedText(row, "id", 80);
        if (!id.matches("[a-z0-9-]{1,80}")) invalidSeed();
        int from = seedYear(row.get("yearFrom"));
        Integer to = row.get("yearTo").isNull() ? null : seedYear(row.get("yearTo"));
        if (to != null && to < from) invalidSeed();
        JsonNode powertrainValues = row.get("powertrains");
        if (!powertrainValues.isArray() || powertrainValues.isEmpty() || powertrainValues.size() > 3) invalidSeed();
        List<String> powertrains = new ArrayList<>();
        for (JsonNode value : powertrainValues) {
            if (!value.isTextual() || !Set.of("ICE", "HYB", "EV").contains(value.textValue())
                    || powertrains.contains(value.textValue())) invalidSeed();
            powertrains.add(value.textValue());
        }
        if (!row.get("representative").isBoolean() || !row.get("representative").booleanValue()) invalidSeed();
        String key = seedText(row, "imageObjectKey", 200);
        if (!key.equals("data/vehicle-catalog/" + id + ".png") && !key.equals("data/vehicle-catalog/" + id + ".jpg")) invalidSeed();
        String source = seedText(row, "imageSourceUrl", 1500);
        String licenseUrl = seedText(row, "imageLicenseUrl", 500);
        if (!httpsUrl(source) || !httpsUrl(licenseUrl)) invalidSeed();
        return new VehicleCatalogEntry(id, seedText(row, "manufacturer", 80), seedText(row, "model", 100),
                seedText(row, "generation", 100), from, to, List.copyOf(powertrains),
                "/api/v1/vehicle-catalog/" + id + "/image", key, source, seedText(row, "imageAuthor", 300),
                seedText(row, "imageLicense", 100), licenseUrl, true, seedText(row, "note", 1000));
    }

    private void validateImage(VehicleCatalogEntry entry) throws IOException {
        ClassPathResource resource;
        try {
            resource = image(entry);
        } catch (ApiException exception) {
            throw new IllegalArgumentException("A packaged vehicle catalog image is missing.", exception);
        }
        if (resource.contentLength() > 10 * 1024 * 1024) invalidSeed();
        try (var stream = resource.getInputStream()) {
            byte[] header = stream.readNBytes(8);
            boolean png = header.length == 8 && (header[0] & 255) == 137 && header[1] == 80 && header[2] == 78
                    && header[3] == 71 && header[4] == 13 && header[5] == 10 && header[6] == 26 && header[7] == 10;
            boolean jpeg = header.length >= 3 && (header[0] & 255) == 255 && (header[1] & 255) == 216 && (header[2] & 255) == 255;
            if (entry.imageObjectKey().endsWith(".png") ? !png : !jpeg) invalidSeed();
        }
    }

    private void upsert(VehicleCatalogEntry entry) {
        Object[] values = values(entry);
        Object[] update = new Object[values.length];
        System.arraycopy(values, 1, update, 0, values.length - 1);
        update[values.length - 1] = entry.id();
        String sql = "UPDATE vehicle_catalog SET manufacturer=?,model=?,generation=?,year_from=?,year_to=?,powertrains=?,"
                + "image_object_key=?,image_source_url=?,image_author=?,image_license=?,image_license_url=?,representative=?,note=? WHERE id=?";
        if (jdbc.update(sql, update) > 0) return;
        try {
            jdbc.update("INSERT INTO vehicle_catalog (" + COLUMNS + ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", values);
        } catch (DuplicateKeyException exception) {
            // Another API instance seeded this ID between UPDATE and INSERT. The failed
            // INSERT is a separate transaction, so PostgreSQL remains usable for the retry.
            if (jdbc.update(sql, update) == 0) throw exception;
        }
    }

    private Object[] values(VehicleCatalogEntry entry) {
        try {
            return new Object[]{entry.id(), entry.manufacturer(), entry.model(), entry.generation(), entry.yearFrom(), entry.yearTo(),
                    json.writeValueAsString(entry.powertrains()), entry.imageObjectKey(), entry.imageSourceUrl(), entry.imageAuthor(),
                    entry.imageLicense(), entry.imageLicenseUrl(), entry.representative(), entry.note()};
        } catch (IOException exception) {
            throw new IllegalStateException("Vehicle catalog metadata cannot be encoded.", exception);
        }
    }

    private VehicleCatalogEntry entry(ResultSet row, int index) throws SQLException {
        try {
            String id = row.getString("id");
            return new VehicleCatalogEntry(id, row.getString("manufacturer"), row.getString("model"), row.getString("generation"),
                    row.getInt("year_from"), row.getObject("year_to", Integer.class),
                    json.readValue(row.getString("powertrains"), new TypeReference<List<String>>() {}),
                    "/api/v1/vehicle-catalog/" + id + "/image", row.getString("image_object_key"), row.getString("image_source_url"),
                    row.getString("image_author"), row.getString("image_license"), row.getString("image_license_url"),
                    row.getBoolean("representative"), row.getString("note"));
        } catch (IOException exception) {
            throw new IllegalStateException("Stored vehicle catalog metadata is invalid.", exception);
        }
    }

    private static String filterText(String value, int maximum) {
        if (value == null) return "";
        if (value.length() > maximum || value.chars().anyMatch(character -> character < 32)) throw ApiException.invalid();
        return value.strip().toLowerCase(Locale.ROOT);
    }

    private static String seedText(JsonNode row, String field, int maximum) {
        JsonNode value = row.get(field);
        if (value == null || !value.isTextual() || value.textValue().isBlank() || value.textValue().length() > maximum
                || value.textValue().chars().anyMatch(character -> character < 32)) invalidSeed();
        return value.textValue();
    }

    private static int seedYear(JsonNode value) {
        if (!value.isIntegralNumber() || !value.canConvertToInt() || value.intValue() < 1950 || value.intValue() > 2100) invalidSeed();
        return value.intValue();
    }

    private static boolean httpsUrl(String value) {
        try {
            URI uri = URI.create(value);
            return "https".equals(uri.getScheme()) && uri.getHost() != null && uri.getUserInfo() == null;
        } catch (IllegalArgumentException exception) {
            return false;
        }
    }

    private static void invalidSeed() { throw new IllegalArgumentException("Invalid packaged vehicle catalog."); }

    private static ApiException notFound() {
        return new ApiException("vehicle_catalog_not_found", "해당 차종의 사진 정보를 찾을 수 없어요.", 404);
    }
}
