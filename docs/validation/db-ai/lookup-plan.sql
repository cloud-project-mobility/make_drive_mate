INSERT INTO accounts(id,email,salt,password_hash,created_at)
SELECT md5(n::text), n || '@fixture.invalid', 'fixture', 'fixture', '2026-01-01T00:00:00Z'
FROM generate_series(1,4000) AS n;
INSERT INTO registered_vehicles(user_id,vehicle_id,name,model,powertrain,odometer_km,created_at,updated_at)
SELECT md5(n::text), 'vehicle-' || v, 'fixture', 'fixture', 'ICE', 1000, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
FROM generate_series(1,4000) AS n CROSS JOIN generate_series(1,3) AS v;
INSERT INTO vehicle_sample_status(user_id,vehicle_id,source,body,saved_at)
SELECT md5(n::text), 'vehicle-1', 'hyundai_sample', '{}', '2026-01-01T00:00:00Z' FROM generate_series(1,4000) AS n;
ANALYZE registered_vehicles;
ANALYZE vehicle_sample_status;
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT v.*,s.body FROM registered_vehicles v JOIN vehicle_sample_status s
ON v.user_id=s.user_id AND v.vehicle_id=s.vehicle_id WHERE v.user_id=md5('2130') AND s.source='hyundai_sample';
