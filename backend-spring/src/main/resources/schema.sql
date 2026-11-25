CREATE TABLE IF NOT EXISTS accounts (
  id VARCHAR(36) PRIMARY KEY,
  email VARCHAR(254) NOT NULL UNIQUE,
  salt VARCHAR(64) NOT NULL,
  password_hash VARCHAR(128) NOT NULL,
  created_at VARCHAR(40) NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS snapshots (
  user_id VARCHAR(36) PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL,
  body TEXT NOT NULL,
  updated_at VARCHAR(40) NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket VARCHAR(150) PRIMARY KEY,
  attempts INTEGER NOT NULL,
  reset_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_reset_idx ON rate_limits(reset_at);

CREATE TABLE IF NOT EXISTS vehicle_catalog (
  id VARCHAR(80) PRIMARY KEY,
  manufacturer VARCHAR(80) NOT NULL,
  model VARCHAR(100) NOT NULL,
  generation VARCHAR(100) NOT NULL,
  year_from INTEGER NOT NULL,
  year_to INTEGER,
  powertrains VARCHAR(64) NOT NULL,
  image_object_key VARCHAR(200) NOT NULL,
  image_source_url VARCHAR(1500) NOT NULL,
  image_author VARCHAR(300) NOT NULL,
  image_license VARCHAR(100) NOT NULL,
  image_license_url VARCHAR(500) NOT NULL,
  representative BOOLEAN NOT NULL,
  note VARCHAR(1000) NOT NULL
);
CREATE INDEX IF NOT EXISTS vehicle_catalog_manufacturer_idx ON vehicle_catalog(manufacturer);

CREATE TABLE IF NOT EXISTS registered_vehicles (
  user_id VARCHAR(36) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  vehicle_id VARCHAR(100) NOT NULL,
  catalog_id VARCHAR(80) REFERENCES vehicle_catalog(id),
  name VARCHAR(60) NOT NULL,
  model VARCHAR(100) NOT NULL,
  powertrain VARCHAR(3) NOT NULL,
  odometer_km DOUBLE PRECISION NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  PRIMARY KEY (user_id, vehicle_id)
);

CREATE TABLE IF NOT EXISTS vehicle_sample_status (
  user_id VARCHAR(36) NOT NULL,
  vehicle_id VARCHAR(100) NOT NULL,
  source VARCHAR(40) NOT NULL,
  body TEXT NOT NULL,
  saved_at VARCHAR(40) NOT NULL,
  PRIMARY KEY (user_id, vehicle_id),
  UNIQUE (user_id, source),
  FOREIGN KEY (user_id, vehicle_id) REFERENCES registered_vehicles(user_id, vehicle_id) ON DELETE CASCADE
);

