-- 全部写入口共享版本。触发器同时覆盖 REST、MCP 与 Google 指标写入。
ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN data_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN membership_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN order_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE links ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE project_articles ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE project_external_articles ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE project_copywriters ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE project_article_current_metrics ADD COLUMN gsc_config_fingerprint TEXT;
ALTER TABLE project_article_current_metrics ADD COLUMN ga4_config_fingerprint TEXT;
ALTER TABLE project_article_current_metrics ADD COLUMN gsc_success_value REAL;
ALTER TABLE project_article_current_metrics ADD COLUMN gsc_success_config TEXT;
ALTER TABLE project_article_current_metrics ADD COLUMN gsc_success_at TEXT;
ALTER TABLE project_article_current_metrics ADD COLUMN ga4_views_success_value REAL;
ALTER TABLE project_article_current_metrics ADD COLUMN ga4_views_success_config TEXT;
ALTER TABLE project_article_current_metrics ADD COLUMN ga4_views_success_at TEXT;
ALTER TABLE project_article_current_metrics ADD COLUMN ga4_key_events_success_value REAL;
ALTER TABLE project_article_current_metrics ADD COLUMN ga4_key_events_success_config TEXT;
ALTER TABLE project_article_current_metrics ADD COLUMN ga4_key_events_success_at TEXT;

CREATE TRIGGER mcp_users_revision AFTER UPDATE ON users
WHEN NEW.revision = OLD.revision AND (NEW.name IS NOT OLD.name OR NEW.role IS NOT OLD.role OR NEW.email IS NOT OLD.email)
BEGIN UPDATE users SET revision = OLD.revision + 1 WHERE id = NEW.id; END;
-- 作者显示名参与分组与报表；修改后原导出快照必须失效。
CREATE TRIGGER mcp_users_project_data AFTER UPDATE ON users
WHEN NEW.name IS NOT OLD.name OR NEW.email IS NOT OLD.email
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE owner_user_id = NEW.id
  OR id IN (SELECT project_id FROM project_copywriters WHERE user_id = NEW.id); END;
CREATE TRIGGER mcp_copywriters_revision AFTER UPDATE ON project_copywriters
WHEN NEW.revision = OLD.revision
BEGIN UPDATE project_copywriters SET revision = OLD.revision + 1 WHERE id = NEW.id; END;

CREATE TABLE mcp_tokens (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE TABLE business_operations (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  token_id TEXT,
  tool TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  project_ids_json TEXT NOT NULL DEFAULT '[]',
  input_json TEXT,
  result_summary_json TEXT,
  kind TEXT NOT NULL DEFAULT 'mutation',
  parent_operation_id TEXT,
  lease_id TEXT,
  lease_expires_at TEXT,
  checkpoint_json TEXT,
  recovery_attempts INTEGER NOT NULL DEFAULT 0,
  progress_completed INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  progress_unit TEXT,
  data_through_json TEXT,
  error_json TEXT,
  detail_expires_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, tool, idempotency_key)
);
CREATE INDEX idx_business_operations_resume ON business_operations(status, lease_expires_at, created_at);
CREATE INDEX idx_business_operations_expire ON business_operations(detail_expires_at);
CREATE UNIQUE INDEX idx_business_active_sync ON business_operations(json_extract(project_ids_json, '$[0]'))
WHERE kind = 'sync' AND status IN ('queued', 'running', 'cancel_requested');
CREATE TABLE business_operation_items (
  operation_id TEXT NOT NULL REFERENCES business_operations(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  state TEXT NOT NULL,
  input_json TEXT,
  expected_revision INTEGER,
  result_json TEXT,
  error_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(operation_id, item_key)
);
CREATE TABLE business_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT REFERENCES business_operations(id) ON DELETE SET NULL,
  user_id INTEGER NOT NULL,
  token_id TEXT,
  tool TEXT NOT NULL,
  item_key TEXT,
  effects_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_business_audit_expire ON business_audit_events(expires_at);
-- CHECK 把版本、身份和租约校验放入同一个 D1 原子单元；失败时整单元回滚。
CREATE TABLE business_mutation_guards (
  operation_id TEXT NOT NULL,
  guard_key TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK(ok = 1),
  PRIMARY KEY(operation_id, guard_key)
);
CREATE TABLE export_artifacts (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES business_operations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  payload_bytes INTEGER NOT NULL DEFAULT 0,
  checksum TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_export_artifact_expire ON export_artifacts(expires_at);
CREATE TABLE export_artifact_chunks (
  artifact_id TEXT NOT NULL REFERENCES export_artifacts(id) ON DELETE CASCADE,
  chunk_no INTEGER NOT NULL,
  payload BLOB,
  rows_json TEXT,
  PRIMARY KEY(artifact_id, chunk_no)
);
CREATE TABLE mcp_request_leases (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_mcp_request_leases ON mcp_request_leases(user_id, expires_at);
CREATE TABLE mcp_usage_days (
  date TEXT PRIMARY KEY,
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  queries INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_mcp_tasks_owner ON tasks(owner_user_id, project_id, due_date, id);
CREATE INDEX idx_mcp_tasks_project ON tasks(project_id, status, id);
CREATE INDEX idx_mcp_links_owner ON links(owner_user_id, project_id, id);
CREATE INDEX idx_mcp_links_project ON links(project_id, id);
CREATE INDEX idx_mcp_projects_owner ON projects(owner_user_id, status, id);
CREATE INDEX idx_mcp_articles_published ON project_articles(project_id, published_at, id);
CREATE INDEX idx_mcp_external_published ON project_external_articles(project_id, published_at, id);

CREATE TRIGGER mcp_projects_revision AFTER UPDATE ON projects
WHEN NEW.revision = OLD.revision AND (
  NEW.name IS NOT OLD.name OR NEW.client_name IS NOT OLD.client_name OR NEW.industry IS NOT OLD.industry
  OR NEW.website IS NOT OLD.website OR NEW.contract_start IS NOT OLD.contract_start OR NEW.contract_end IS NOT OLD.contract_end
  OR NEW.monthly_fee IS NOT OLD.monthly_fee OR NEW.status IS NOT OLD.status OR NEW.notes IS NOT OLD.notes
  OR NEW.owner_user_id IS NOT OLD.owner_user_id)
BEGIN UPDATE projects SET revision = OLD.revision + 1 WHERE id = NEW.id; END;

CREATE TRIGGER mcp_projects_configuration AFTER UPDATE ON projects
WHEN NEW.account_id IS NOT OLD.account_id OR NEW.gsc_account_id IS NOT OLD.gsc_account_id OR NEW.gsc_site IS NOT OLD.gsc_site
  OR NEW.ga4_account_id IS NOT OLD.ga4_account_id OR NEW.ga4_property_id IS NOT OLD.ga4_property_id
  OR NEW.key_event_names IS NOT OLD.key_event_names
BEGIN UPDATE projects SET config_revision = OLD.config_revision + 1, data_revision = data_revision + 1 WHERE id = NEW.id; END;

CREATE TRIGGER mcp_sync_configuration AFTER UPDATE ON project_monitor_sync_state
WHEN NEW.config_revision IS NOT OLD.config_revision OR NEW.monitor_start_month IS NOT OLD.monitor_start_month
BEGIN UPDATE projects SET config_revision = config_revision + 1, data_revision = data_revision + 1 WHERE id = NEW.project_id; END;
CREATE TRIGGER mcp_sync_configuration_insert AFTER INSERT ON project_monitor_sync_state
WHEN NEW.monitor_start_month IS NOT NULL
BEGIN UPDATE projects SET config_revision = config_revision + 1, data_revision = data_revision + 1 WHERE id = NEW.project_id; END;

CREATE TRIGGER mcp_tasks_revision AFTER UPDATE ON tasks
WHEN NEW.revision = OLD.revision
BEGIN UPDATE tasks SET revision = OLD.revision + 1 WHERE id = NEW.id; END;
CREATE TRIGGER mcp_tasks_insert_collection AFTER INSERT ON tasks
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = NEW.project_id;
END;
CREATE TRIGGER mcp_tasks_update_collection AFTER UPDATE ON tasks WHEN NEW.revision = OLD.revision
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = NEW.project_id;
UPDATE projects SET data_revision = data_revision + 1 WHERE id = OLD.project_id AND OLD.project_id IS NOT NEW.project_id;
END;
CREATE TRIGGER mcp_tasks_delete_collection AFTER DELETE ON tasks
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = OLD.project_id;
END;

CREATE TRIGGER mcp_links_revision AFTER UPDATE ON links
WHEN NEW.revision = OLD.revision
BEGIN UPDATE links SET revision = OLD.revision + 1 WHERE id = NEW.id; END;
CREATE TRIGGER mcp_links_insert_collection AFTER INSERT ON links
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = NEW.project_id;
END;
CREATE TRIGGER mcp_links_update_collection AFTER UPDATE ON links WHEN NEW.revision = OLD.revision
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = NEW.project_id;
UPDATE projects SET data_revision = data_revision + 1 WHERE id = OLD.project_id AND OLD.project_id IS NOT NEW.project_id;
END;
CREATE TRIGGER mcp_links_delete_collection AFTER DELETE ON links
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = OLD.project_id;
END;

CREATE TRIGGER mcp_project_articles_revision AFTER UPDATE ON project_articles
WHEN NEW.revision = OLD.revision
BEGIN UPDATE project_articles SET revision = OLD.revision + 1 WHERE id = NEW.id; END;
CREATE TRIGGER mcp_project_articles_insert_collection AFTER INSERT ON project_articles
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = NEW.project_id;
UPDATE projects SET order_revision = order_revision + 1 WHERE id = NEW.project_id;
END;
CREATE TRIGGER mcp_project_articles_update_collection AFTER UPDATE ON project_articles WHEN NEW.revision = OLD.revision
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = NEW.project_id;
UPDATE projects SET data_revision = data_revision + 1 WHERE id = OLD.project_id AND OLD.project_id IS NOT NEW.project_id;
UPDATE projects SET order_revision = order_revision + 1 WHERE id = NEW.project_id AND NEW.sort_order IS NOT OLD.sort_order;
END;
CREATE TRIGGER mcp_project_articles_delete_collection AFTER DELETE ON project_articles
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = OLD.project_id;
UPDATE projects SET order_revision = order_revision + 1 WHERE id = OLD.project_id;
END;

CREATE TRIGGER mcp_project_external_articles_revision AFTER UPDATE ON project_external_articles
WHEN NEW.revision = OLD.revision
BEGIN UPDATE project_external_articles SET revision = OLD.revision + 1 WHERE id = NEW.id; END;
CREATE TRIGGER mcp_project_external_articles_insert_collection AFTER INSERT ON project_external_articles
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = NEW.project_id;
UPDATE projects SET order_revision = order_revision + 1 WHERE id = NEW.project_id;
END;
CREATE TRIGGER mcp_project_external_articles_update_collection AFTER UPDATE ON project_external_articles WHEN NEW.revision = OLD.revision
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = NEW.project_id;
UPDATE projects SET data_revision = data_revision + 1 WHERE id = OLD.project_id AND OLD.project_id IS NOT NEW.project_id;
END;
CREATE TRIGGER mcp_project_external_articles_delete_collection AFTER DELETE ON project_external_articles
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = OLD.project_id;
UPDATE projects SET order_revision = order_revision + 1 WHERE id = OLD.project_id;
END;
CREATE TRIGGER mcp_project_article_monthly_metrics_insert_data AFTER INSERT ON project_article_monthly_metrics
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = (SELECT project_id FROM project_articles WHERE id = NEW.article_id); END;
CREATE TRIGGER mcp_project_article_monthly_metrics_update_data AFTER UPDATE ON project_article_monthly_metrics
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = (SELECT project_id FROM project_articles WHERE id = NEW.article_id); END;
CREATE TRIGGER mcp_project_article_monthly_metrics_delete_data AFTER DELETE ON project_article_monthly_metrics
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = (SELECT project_id FROM project_articles WHERE id = OLD.article_id); END;
CREATE TRIGGER mcp_project_article_current_metrics_insert_data AFTER INSERT ON project_article_current_metrics
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = (SELECT project_id FROM project_articles WHERE id = NEW.article_id); END;
CREATE TRIGGER mcp_project_article_current_metrics_update_data AFTER UPDATE ON project_article_current_metrics
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = (SELECT project_id FROM project_articles WHERE id = NEW.article_id); END;
CREATE TRIGGER mcp_project_article_current_metrics_delete_data AFTER DELETE ON project_article_current_metrics
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = (SELECT project_id FROM project_articles WHERE id = OLD.article_id); END;
CREATE TRIGGER mcp_project_article_url_history_insert_data AFTER INSERT ON project_article_url_history
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = NEW.project_id; END;
CREATE TRIGGER mcp_project_article_url_history_update_data AFTER UPDATE ON project_article_url_history
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = NEW.project_id; END;
CREATE TRIGGER mcp_project_article_url_history_delete_data AFTER DELETE ON project_article_url_history
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = OLD.project_id; END;
CREATE TRIGGER mcp_project_external_article_freezes_insert_data AFTER INSERT ON project_external_article_freezes
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = NEW.project_id; END;
CREATE TRIGGER mcp_project_external_article_freezes_update_data AFTER UPDATE ON project_external_article_freezes
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = NEW.project_id; END;
CREATE TRIGGER mcp_project_external_article_freezes_delete_data AFTER DELETE ON project_external_article_freezes
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = OLD.project_id; END;
CREATE TRIGGER mcp_project_external_daily_metrics_insert_data AFTER INSERT ON project_external_daily_metrics
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = NEW.project_id; END;
CREATE TRIGGER mcp_project_external_daily_metrics_update_data AFTER UPDATE ON project_external_daily_metrics
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = NEW.project_id; END;
CREATE TRIGGER mcp_project_external_daily_metrics_delete_data AFTER DELETE ON project_external_daily_metrics
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = OLD.project_id; END;
CREATE TRIGGER mcp_project_external_month_state_insert_data AFTER INSERT ON project_external_month_state
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = NEW.project_id; END;
CREATE TRIGGER mcp_project_external_month_state_update_data AFTER UPDATE ON project_external_month_state
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = NEW.project_id; END;
CREATE TRIGGER mcp_project_external_month_state_delete_data AFTER DELETE ON project_external_month_state
BEGIN UPDATE projects SET data_revision = data_revision + 1 WHERE id = OLD.project_id; END;
CREATE TRIGGER mcp_project_copywriters_insert_data AFTER INSERT ON project_copywriters
BEGIN UPDATE projects SET data_revision = data_revision + 1, membership_revision = membership_revision + 1 WHERE id = NEW.project_id; END;
CREATE TRIGGER mcp_project_copywriters_update_data AFTER UPDATE ON project_copywriters
BEGIN UPDATE projects SET data_revision = data_revision + 1, membership_revision = membership_revision + 1 WHERE id = NEW.project_id; END;
CREATE TRIGGER mcp_project_copywriters_delete_data AFTER DELETE ON project_copywriters
BEGIN UPDATE projects SET data_revision = data_revision + 1, membership_revision = membership_revision + 1 WHERE id = OLD.project_id; END;
