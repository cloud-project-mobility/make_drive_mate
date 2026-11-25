package com.drivemate.api.providers;

import static com.drivemate.api.providers.ProviderSupport.*;
import com.drivemate.api.AppSettings;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Service;

/** Explicit remote sample request; never falls back to locally fabricated data. */
@Service
public class HyundaiSampleProvider {
    private final Environment environment;
    private final AppSettings settings;
    private final ProviderHttp http;

    public HyundaiSampleProvider(Environment environment, AppSettings settings, ProviderHttp http) {
        this.environment = environment;
        this.settings = settings;
        this.http = http;
    }

    public Map<String, Object> fetch(String powertrain) {
        if (!Set.of("ICE", "HYB", "EV").contains(powertrain)) throw new IllegalArgumentException("Invalid app vehicle category");
        enabled(settings.providerMode());
        if (!"true".equals(environment.getProperty("DRIVEMATE_HYUNDAI_SAMPLE_ENABLED", "false"))) {
            throw new ProviderException("hyundai_sample_disabled", "현대 샘플 가져오기가 서버에서 활성화되지 않았어요.", 503);
        }
        String token = environment.getProperty("HYUNDAI_SAMPLE_TOKEN", "");
        String carId = environment.getProperty("HYUNDAI_SAMPLE_CAR_ID", "");
        if (token.length() < 1 || token.length() > 16384 || !token.matches("[A-Za-z0-9._~+/-]+=*")
                || !carId.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")) {
            throw new ProviderException("hyundai_sample_not_configured", "서버의 현대 Sample Token과 Sample Car ID 설정을 확인해 주세요.", 503);
        }
        // This exact Sample path was supplied in the earlier console curl experiment.
        // Do not substitute the real-vehicle /api/v1 path or accept a caller-supplied URL.
        var response = http.get("https://dev.kr-ccapi.hyundai.com/api_sample/v1/car/status/" + carId + "/odometer",
                Map.of(), "Bearer " + token);
        Map<String, Object> result = HyundaiProvider.normalizeOdometer(response, Instant.now());
        if (((Number) result.get("odometer_km")).doubleValue() > 2_000_000) throw malformed();
        result.putAll(map("source", "hyundai_sample", "is_mock", true, "is_sample", true,
                "provider", "hyundai", "provider_vehicle_id", "hyundai-odometer-sample",
                "model", "현대 샘플 차량 · 차종 미확인", "powertrain", powertrain,
                "vehicle_profile_source", "user_selected_app_category",
                "transport_verified", !http.isTestTransport(),
                "notice", "현대 Sample API의 누적거리입니다. 실제 차량 정보가 아니며 차종·배터리·경고 상태는 조회하지 않았어요."));
        return result;
    }
}
