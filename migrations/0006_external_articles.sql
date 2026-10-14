-- 0006_external_articles.sql —— 外链模型：平台（项目×域名）日数据 + 冻结结构 + 旧记录归档（任务10）
--
-- 与旧模型的区别（契约）：
--   - 平台身份 = 项目 × 域名（主机归一化：小写/去www/去端口，保留子域名），
--     不再按根域名折叠；原 root-domain 累计与新 domain 不一定一一对应，旧值只进归档表。
--   - 日数据按（项目, 域名, 日期, 来源, 配置指纹）存：换指纹后旧行不删，
--     当前 SUM 只算当前指纹的行（"旧指纹行不得进入当前SUM"）。
--   - 用户与所选事件分两个来源独立存（两个 GA4 请求独立成败）。
--   - 冻结表先建结构，写入行为在任务11（不提前暴露启停接口）。
--   - project_external_legacy_metrics：旧 external_links 每行一条归档（id→新文章映射 + 累计 + 水位），
--     仅核对用，不直接 SUM 为平台数。
--
-- 存量迁移口径：
--   - 按（项目, URL）分组去重合并；组内非空元数据（anchor_text/published_at/notes）
--     一致才合并（取非空值），有冲突的组不迁移、留在旧表等人工处理（预检脚本列清单）。
--   - 迁移登记默认 active，活跃段从迁移业务日开始；没有可信启停史，不补造冻结。
--   - 旧的累计/水位原样进归档表，不当成新平台的日数据。

-- ============ 外链文章登记 ============
CREATE TABLE project_external_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  domain_source TEXT NOT NULL DEFAULT 'auto' CHECK (domain_source IN ('auto', 'manual')),
  title TEXT,
  anchor_text TEXT,
  notes TEXT,
  copywriter_id INTEGER REFERENCES project_copywriters(id) ON DELETE SET NULL,
  published_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  -- 活跃段：启停与冻结的载体。迁移来的从迁移业务日开始；任务11 的停用/恢复改写这两个字段
  active_segment_started_at TEXT,
  segment_revision INTEGER NOT NULL DEFAULT 1,
  registry_revision INTEGER NOT NULL DEFAULT 1,
  metrics_dirty INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, url),
  UNIQUE (id, project_id),
  FOREIGN KEY (project_id, copywriter_id) REFERENCES project_copywriters (project_id, id)
);
CREATE INDEX idx_ext_articles_project ON project_external_articles (project_id, status);
CREATE INDEX idx_ext_articles_domain ON project_external_articles (project_id, domain);
CREATE INDEX idx_ext_articles_copywriter ON project_external_articles (project_id, copywriter_id);

-- ============ 平台日数据（按来源分行，旧指纹行保留但不进当前 SUM） ============
CREATE TABLE project_external_daily_metrics (
  project_id INTEGER NOT NULL,
  domain TEXT NOT NULL,
  date TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('users', 'events')),
  value INTEGER NOT NULL,
  config_fingerprint TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (project_id, domain, date, source, config_fingerprint),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX idx_ext_daily_lookup ON project_external_daily_metrics (project_id, domain, date, source);

-- ============ 平台月状态（各来源覆盖/定稿/错误） ============
CREATE TABLE project_external_month_state (
  project_id INTEGER NOT NULL,
  domain TEXT NOT NULL,
  month TEXT NOT NULL,
  users_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (users_status IN ('pending', 'complete', 'unavailable', 'error')),
  events_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (events_status IN ('pending', 'complete', 'unavailable', 'error')),
  users_cover_start TEXT,
  users_cover_end TEXT,
  events_cover_start TEXT,
  events_cover_end TEXT,
  users_fetched_at TEXT,
  events_fetched_at TEXT,
  users_fingerprint TEXT,
  events_fingerprint TEXT,
  finalized INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, domain, month),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- ============ 冻结段（结构先行，写入在任务11） ============
CREATE TABLE project_external_article_freezes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  domain TEXT NOT NULL,
  segment_revision INTEGER NOT NULL,
  freeze_start TEXT NOT NULL,
  freeze_end TEXT NOT NULL,
  share REAL NOT NULL,
  users_value INTEGER,
  events_value INTEGER,
  -- partial = 区间部分日期有数据（已知和 + 不完整）；空段记 complete 值 0；无任何数据记 pending 未知
  users_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (users_status IN ('pending', 'partial', 'complete', 'unavailable', 'error')),
  events_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (events_status IN ('pending', 'partial', 'complete', 'unavailable', 'error')),
  data_through TEXT,
  config_fingerprint TEXT,
  revoked_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (article_id, segment_revision),
  FOREIGN KEY (article_id, project_id) REFERENCES project_external_articles (id, project_id) ON DELETE CASCADE
);

-- ============ 旧外链归档（每行一条，仅核对） ============
CREATE TABLE project_external_legacy_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  legacy_id INTEGER NOT NULL,
  article_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  anchor_text TEXT,
  published_at TEXT,
  notes TEXT,
  sessions INTEGER,
  users INTEGER,
  key_events INTEGER,
  settled_through TEXT,
  key_events_through TEXT,
  legacy_fetched_at TEXT,
  migrated_at TEXT NOT NULL,
  UNIQUE (legacy_id),
  FOREIGN KEY (article_id) REFERENCES project_external_articles(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- ============ 存量迁移：external_links → 新模型 ============

-- 1) 文章登记：按（项目, URL）合并无冲突组；冲突组留在旧表（预检脚本列清单，人工处理后再来）
INSERT INTO project_external_articles
  (project_id, url, domain, domain_source, anchor_text, notes, published_at, status,
   active_segment_started_at, segment_revision, registry_revision, metrics_dirty,
   created_at, updated_at)
WITH conflicts AS (
  SELECT project_id, url FROM external_links
  GROUP BY project_id, url
  HAVING COUNT(DISTINCT anchor_text) > 1
      OR COUNT(DISTINCT published_at) > 1
      OR COUNT(DISTINCT notes) > 1
),
clean AS (
  SELECT l.project_id AS project_id,
         l.url AS url,
         MAX(l.anchor_text) AS anchor_text,   -- 组内一致，MAX 忽略 NULL 取到那个非空值
         MAX(l.notes) AS notes,
         MAX(l.published_at) AS published_at,
         MIN(l.created_at) AS created_at
  FROM external_links l
  WHERE NOT EXISTS (SELECT 1 FROM conflicts c WHERE c.project_id = l.project_id AND c.url = l.url)
  GROUP BY l.project_id, l.url
),
host AS (
  SELECT c.*,
         lower(substr(c.url, instr(c.url, '://') + 3,
                CASE WHEN instr(substr(c.url, instr(c.url, '://') + 3), '/') > 0
                     THEN instr(substr(c.url, instr(c.url, '://') + 3), '/') - 1
                     ELSE length(substr(c.url, instr(c.url, '://') + 3)) END)) AS raw_host
  FROM clean c
),
dom AS (
  -- 先去端口再去 www：两步链式，避免「www.example.com:8080」只去一半
  SELECT h.*,
         CASE WHEN instr(raw_host, ':') > 0 THEN substr(raw_host, 1, instr(raw_host, ':') - 1) ELSE raw_host END AS host_noport
  FROM host h
)
SELECT project_id, url,
       CASE WHEN host_noport LIKE 'www.%' THEN substr(host_noport, 5) ELSE host_noport END AS domain,
       'auto', anchor_text, notes, published_at, 'active',
       date('now'), 1, 1, 1,
       COALESCE(created_at, datetime('now')), datetime('now')
FROM dom;

-- 2) 旧行归档：每条 external_links 一行（含旧 id → 新文章映射）
INSERT INTO project_external_legacy_metrics
  (legacy_id, article_id, project_id, url, domain, anchor_text, published_at, notes,
   sessions, users, key_events, settled_through, key_events_through, legacy_fetched_at, migrated_at)
SELECT l.id, a.id, l.project_id, l.url, a.domain, l.anchor_text, l.published_at, l.notes,
       l.sessions, l.users, l.key_events, l.settled_through, l.key_events_through, l.last_fetched_at,
       datetime('now')
FROM external_links l
JOIN project_external_articles a ON a.project_id = l.project_id AND a.url = l.url;
