package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AnalyticsController {
    private static final int MAX_REPORT_BYTES = 1024 * 1024;
    private final Auth auth;
    private final ObjectMapper json;
    private final String reportPath;

    public AnalyticsController(Auth auth, ObjectMapper json,
            @Value("${DRIVEMATE_ANALYTICS_REPORT:}") String reportPath) {
        this.auth = auth;
        this.json = json;
        this.reportPath = reportPath;
    }

    @GetMapping("/api/v1/analytics/latest")
    public JsonNode latest(HttpServletRequest request) {
        auth.require(request);
        return readReport();
    }

    JsonNode readReport() {
        if (reportPath.isBlank()) {
            throw new ApiException("analytics_unavailable", "완료된 데이터 분석 보고서가 아직 없어요.", 503);
        }
        try (var input = Files.newInputStream(Path.of(reportPath))) {
            byte[] bytes = input.readNBytes(MAX_REPORT_BYTES + 1);
            if (bytes.length > MAX_REPORT_BYTES) throw new IOException("Report too large");
            JsonNode report = json.readTree(bytes);
            if (report == null || !"drivemate-cycle-v1".equals(report.path("schema_version").asText())
                    || !"completed".equals(report.path("status").asText())
                    || !report.path("quality").isObject() || !report.path("model").isObject() || !report.path("charts").isObject()) {
                throw new IOException("Report contract invalid");
            }
            return report;
        } catch (Exception exception) {
            throw new ApiException("analytics_unavailable", "완료된 데이터 분석 보고서를 읽을 수 없어요.", 503);
        }
    }
}
