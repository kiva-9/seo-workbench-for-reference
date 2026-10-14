CREATE TABLE ai_project_settings (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  updated_by INTEGER NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
CREATE TABLE ai_insight_runs (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  module TEXT NOT NULL CHECK(module IN ('performance','news','indexing')),
  idempotency_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  settings_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','partial','failed','cancelled','uncertain')),
  lease_token TEXT,
  lease_until TEXT,
  external_started INTEGER NOT NULL DEFAULT 0,
  retry_of TEXT REFERENCES ai_insight_runs(id),
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(project_id,module,idempotency_key),
  UNIQUE(project_id,id)
);
CREATE INDEX ai_runs_queue ON ai_insight_runs(status,created_at);
CREATE TABLE ai_insights (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  module TEXT NOT NULL CHECK(module IN ('performance','news','indexing')),
  entity_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  category TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  url TEXT,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  feedback TEXT NOT NULL DEFAULT 'unread' CHECK(feedback IN ('unread','useful','ignored','handled')),
  generated_at TEXT NOT NULL,
  UNIQUE(project_id,module,entity_key),
  UNIQUE(project_id,id),
  FOREIGN KEY(project_id,run_id) REFERENCES ai_insight_runs(project_id,id) ON DELETE CASCADE
);
CREATE INDEX ai_insights_overview ON ai_insights(module,priority DESC,generated_at DESC,id);
CREATE TABLE ai_insight_feedback (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  insight_id TEXT NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK(action IN ('unread','useful','ignored','handled')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id,insight_id) REFERENCES ai_insights(project_id,id) ON DELETE CASCADE
);
CREATE TABLE ai_news_items (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  UNIQUE(project_id,dedupe_key)
);
CREATE TABLE ai_index_snapshots (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  article_id INTEGER,
  url TEXT NOT NULL,
  property TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK(valid IN (0,1)),
  status TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  UNIQUE(run_id,url),
  FOREIGN KEY(project_id,run_id) REFERENCES ai_insight_runs(project_id,id) ON DELETE CASCADE
);
CREATE INDEX ai_index_history ON ai_index_snapshots(project_id,url,checked_at DESC);
CREATE TABLE ai_usage (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  business_day TEXT NOT NULL,
  reserved_cost REAL NOT NULL DEFAULT 0 CHECK(reserved_cost>=0),
  actual_cost REAL,
  status TEXT NOT NULL CHECK(status IN ('reserved','succeeded','failed','uncertain')),
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id,run_id) REFERENCES ai_insight_runs(project_id,id) ON DELETE CASCADE
);
CREATE INDEX ai_usage_window ON ai_usage(kind,scope,business_day,created_at);
CREATE TABLE ai_schedule_days (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  module TEXT NOT NULL,
  business_day TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES ai_insight_runs(id) ON DELETE CASCADE,
  PRIMARY KEY(project_id,module,business_day)
);
