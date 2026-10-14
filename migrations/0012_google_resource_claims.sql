ALTER TABLE google_accounts ADD COLUMN auth_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN origin_candidate_id INTEGER;
CREATE UNIQUE INDEX projects_origin_candidate ON projects(origin_candidate_id) WHERE origin_candidate_id IS NOT NULL;

CREATE TABLE google_resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('gsc','ga4')),
  resource_key TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  account_display_name TEXT NOT NULL DEFAULT '',
  permission_level TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'available' CHECK(state IN ('available','removed')),
  revision INTEGER NOT NULL DEFAULT 1,
  stream_state TEXT NOT NULL DEFAULT 'pending' CHECK(stream_state IN ('pending','complete','error','app_only','no_website')),
  generation TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(account_id,source,resource_key)
);
CREATE INDEX google_resources_source ON google_resources(account_id,source,state);
CREATE TABLE google_resource_domains (
  resource_id INTEGER NOT NULL REFERENCES google_resources(id) ON DELETE CASCADE,
  stream_key TEXT NOT NULL,
  stream_type TEXT NOT NULL,
  website TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(resource_id,stream_key)
);
CREATE INDEX google_resource_domains_hostname ON google_resource_domains(hostname,resource_id);

CREATE TABLE google_resource_sync_jobs (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE,
  requested_by INTEGER REFERENCES users(id),
  auth_revision INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','partial','failed','cancelled')),
  cursor_json TEXT NOT NULL DEFAULT '{}',
  errors_json TEXT NOT NULL DEFAULT '[]',
  units_done INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX google_resource_sync_active ON google_resource_sync_jobs(account_id) WHERE status IN ('queued','running');
CREATE TABLE google_resource_sync_sources (
  account_id INTEGER NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('gsc','ga4')),
  last_success_at TEXT,
  last_error TEXT,
  PRIMARY KEY(account_id,source)
);

CREATE TABLE project_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hostname TEXT NOT NULL UNIQUE,
  website TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  fingerprint TEXT NOT NULL DEFAULT '',
  existing_project_ids TEXT NOT NULL DEFAULT '[]',
  resolved_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  claimed_by INTEGER REFERENCES users(id),
  claim_key TEXT,
  claim_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE project_candidate_preferences (
  candidate_id INTEGER NOT NULL REFERENCES project_candidates(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
  PRIMARY KEY(candidate_id,user_id)
);
CREATE TABLE project_source_policies (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('gsc','ga4')),
  mode TEXT NOT NULL CHECK(mode IN ('manual','disabled')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id,source)
);
CREATE TABLE project_resource_grants (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('gsc','ga4')),
  account_id INTEGER NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE,
  resource_key TEXT NOT NULL,
  candidate_id INTEGER REFERENCES project_candidates(id) ON DELETE SET NULL,
  granted_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(project_id,source,account_id,resource_key)
);

-- 存量来源是人工选择；尚未核验的配置保留，目录刷新只生成建议。
INSERT INTO project_source_policies(project_id,source,mode,updated_at)
SELECT id,'gsc',CASE WHEN gsc_site IS NOT NULL AND gsc_site<>'' THEN 'manual' ELSE 'disabled' END,datetime('now') FROM projects;
INSERT INTO project_source_policies(project_id,source,mode,updated_at)
SELECT id,'ga4',CASE WHEN ga4_property_id IS NOT NULL AND ga4_property_id<>'' THEN 'manual' ELSE 'disabled' END,datetime('now') FROM projects;
INSERT INTO project_resource_grants(project_id,source,account_id,resource_key,created_at)
SELECT p.id,'gsc',COALESCE(p.gsc_account_id,p.account_id),p.gsc_site,datetime('now') FROM projects p
JOIN google_accounts a ON a.id=COALESCE(p.gsc_account_id,p.account_id) WHERE p.gsc_site IS NOT NULL AND p.gsc_site<>'';
INSERT INTO project_resource_grants(project_id,source,account_id,resource_key,created_at)
SELECT p.id,'ga4',COALESCE(p.ga4_account_id,p.account_id),p.ga4_property_id,datetime('now') FROM projects p
JOIN google_accounts a ON a.id=COALESCE(p.ga4_account_id,p.account_id) WHERE p.ga4_property_id IS NOT NULL AND p.ga4_property_id<>'';

CREATE TRIGGER projects_source_policies_insert AFTER INSERT ON projects BEGIN
  INSERT INTO project_source_policies(project_id,source,mode,updated_by,updated_at)
    VALUES (NEW.id,'gsc',CASE WHEN COALESCE(NEW.gsc_site,'')<>'' THEN 'manual' ELSE 'disabled' END,NEW.owner_user_id,COALESCE(NEW.created_at,datetime('now')));
  INSERT INTO project_source_policies(project_id,source,mode,updated_by,updated_at)
    VALUES (NEW.id,'ga4',CASE WHEN COALESCE(NEW.ga4_property_id,'')<>'' THEN 'manual' ELSE 'disabled' END,NEW.owner_user_id,COALESCE(NEW.created_at,datetime('now')));
  INSERT INTO project_resource_grants(project_id,source,account_id,resource_key,granted_by,created_at)
    SELECT NEW.id,'gsc',a.id,NEW.gsc_site,NEW.owner_user_id,COALESCE(NEW.created_at,datetime('now')) FROM google_accounts a
      WHERE a.id=COALESCE(NEW.gsc_account_id,NEW.account_id) AND COALESCE(NEW.gsc_site,'')<>'';
  INSERT INTO project_resource_grants(project_id,source,account_id,resource_key,granted_by,created_at)
    SELECT NEW.id,'ga4',a.id,NEW.ga4_property_id,NEW.owner_user_id,COALESCE(NEW.created_at,datetime('now')) FROM google_accounts a
      WHERE a.id=COALESCE(NEW.ga4_account_id,NEW.account_id) AND COALESCE(NEW.ga4_property_id,'')<>'';
END;
