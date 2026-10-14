CREATE TABLE ai_model_configuration (
  id INTEGER PRIMARY KEY CHECK(id=1),
  version INTEGER NOT NULL CHECK(version>0),
  base_url TEXT NOT NULL,
  model_name TEXT NOT NULL,
  encrypted_api_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  input_rate REAL CHECK(input_rate>=0),
  output_rate REAL CHECK(output_rate>=0),
  call_ceiling REAL NOT NULL DEFAULT 0 CHECK(call_ceiling>=0),
  updated_by INTEGER NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
CREATE TABLE ai_model_config_events (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  base_url TEXT NOT NULL,
  model_name TEXT NOT NULL,
  key_action TEXT NOT NULL CHECK(key_action IN ('kept','replaced','cleared')),
  created_at TEXT NOT NULL
);
