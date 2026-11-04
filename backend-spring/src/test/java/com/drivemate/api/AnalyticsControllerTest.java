package com.drivemate.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;

class AnalyticsControllerTest {
    @TempDir Path directory;

    @Test void fixedLatestCompletedReportCanBeRead() throws Exception {
        Path report = directory.resolve("latest.json");
        Files.writeString(report, """
                {"schema_version":"drivemate-cycle-v1","status":"completed","quality":{"clean_rows":2197},
                 "model":{"selected_model":"RandomForest"},"charts":{}}
                """);
        AnalyticsController controller = new AnalyticsController(null, new ObjectMapper(), report.toString());
        assertThat(controller.readReport().path("quality").path("clean_rows").asInt()).isEqualTo(2197);
    }

    @Test void missingPartialOrInvalidReportsNeverLeakLocalDetails() throws Exception {
        Path report = directory.resolve("private-path.json");
        AnalyticsController controller = new AnalyticsController(null, new ObjectMapper(), report.toString());
        ApiException error = assertThrows(ApiException.class, controller::readReport);
        assertThat(error.status()).isEqualTo(503);
        assertThat(error.getMessage()).doesNotContain("private-path");
        Files.writeString(report, "{\"schema_version\":\"drivemate-cycle-v1\",\"status\":\"running\"}");
        assertThrows(ApiException.class, controller::readReport);
        Files.writeString(report, "unexpected-secret-content");
        assertThat(assertThrows(ApiException.class, controller::readReport).getMessage()).doesNotContain("unexpected-secret-content");
    }
}
