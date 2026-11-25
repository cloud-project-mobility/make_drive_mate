import com.drivemate.api.*;
import com.drivemate.api.providers.HyundaiSampleProvider;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import java.util.UUID;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.transaction.support.TransactionTemplate;
import static org.mockito.Mockito.*;

/** Runs the same public service methods against either compiled checkout, using exclusively synthetic inputs. */
public class SampleRefreshProbe {
    static Map<String, Object> reading(int km, String observed, String received) {
        return Map.of("source", "hyundai_sample", "is_mock", true, "is_sample", true,
                "vehicle_profile_source", "user_selected_app_category", "provider_vehicle_id", "probe",
                "model", "Sample", "powertrain", "ICE", "odometer_km", km, "received_at", received,
                "provider_timestamp_raw", observed);
    }

    public static void main(String[] args) {
        int port = Integer.parseInt(System.getenv("DRIVEMATE_TEST_PG_PORT"));
        var ds = new DriverManagerDataSource("jdbc:postgresql://127.0.0.1:" + port + "/postgres",
                "hyundai_review", System.getenv("DRIVEMATE_TEST_PG_PASSWORD"));
        new ResourceDatabasePopulator(new ClassPathResource("schema.sql")).execute(ds);
        var db = new JdbcTemplate(ds);
        var tx = new TransactionTemplate(new DataSourceTransactionManager(ds));
        var mapper = new ObjectMapper();
        var provider = mock(HyundaiSampleProvider.class);
        var vehicles = new VehicleRegistrationService(db, tx, mock(VehicleCatalogService.class));
        var service = new HyundaiSampleService(db, tx, mapper, vehicles, provider);
        String id = UUID.randomUUID().toString();
        String t1 = "2026-01-01T00:00:00Z", t2 = "2026-01-02T00:00:00Z", t3 = "2026-01-03T00:00:00Z";
        db.update("INSERT INTO accounts (id,email,salt,password_hash,created_at) VALUES (?,?,?,?,?)",
                id, id + "@example.invalid", "synthetic", "synthetic", t1);
        when(provider.fetch("ICE")).thenReturn(reading(1000,"20260101000000",t1), reading(1100,"20260102000000",t2),
                reading(1100,"20260102000000",t3), reading(950,"20260101000000",t3));
        for (String label : new String[]{"create", "newer", "duplicate", "older"}) {
            db.queryForObject("SELECT 'dm_probe_begin_" + label + "'", String.class);
            var response = mapper.valueToTree(service.refresh(id, "ICE"));
            db.queryForObject("SELECT 'dm_probe_end_" + label + "'", String.class);
            System.out.println("RESULT " + label + " " + response.at("/vehicle/odometerKm").asInt()
                    + " " + response.at("/status/odometer_km").asInt());
        }
        String manualId = UUID.randomUUID().toString();
        var manual = mapper.createObjectNode().put("id", manualId).put("name","Manual").put("model","Manual")
                .put("powertrain","ICE").put("odometerKm",20).put("createdAt",t1);
        vehicles.save(id, manualId, manual);
        db.queryForObject("SELECT 'dm_probe_begin_manual_update'", String.class);
        vehicles.save(id, manualId, manual.put("odometerKm",30));
        db.queryForObject("SELECT 'dm_probe_end_manual_update'", String.class);
        System.out.println("RESULT manual_update 30 30");
    }
}
