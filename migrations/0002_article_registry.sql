-- 0002_article_registry.sql —— 站内文章数据模型 + 存量迁移（双端共用：本地 node:sqlite / D1）
--
-- 建六张新表（任务04范围）：
--   project_copywriters            项目内文案师名单（引用已有登录账号，不建人员身份）
--   project_articles               稳定文章身份（保留 urls 原 id 与元数据）
--   project_article_url_history    曾用地址历史（改址不删历史指标）
--   project_article_monthly_metrics 按自然月的月度指标与各来源状态
--   project_article_legacy_metrics 每篇旧文章一份不可变迁移基线（GA4 旧累计）
--   project_monitor_sync_state     项目级同步运行状态（只由同步请求认领/释放）
--
-- 数据来源（任务14之前旧表原样保留，本迁移只读取、不删除、不改写）：
--   urls          → project_articles（原 id/元数据照搬，published_date → published_at）
--   url_metrics   → project_article_monthly_metrics（只取自然月候选，按结束日去重，不 SUM）
--   ga4_metrics   → project_article_legacy_metrics（累计原样复制 + 各自水位）
-- 自定义/跨月窗口不拆分、不猜数、不进月度累计，继续留在 url_metrics 作归档（退役前必须可读导出）。
--
-- 纯 SQL：不写 BEGIN/COMMIT（本地执行器与 wrangler 各自包事务）。
-- 外键级联保证项目删除时新表一起清；PRAGMA foreign_keys 两个后端都默认开启，
-- 存量里的孤儿行会让本迁移直接失败——先用 scripts/precheck-article-registry.mjs 检查修好，
-- 不做静默丢行。

-- ============ 结构 ============

-- 文案师名单：项目内对 users 账号的引用。UNIQUE(project_id, id) 是给文章表
-- 复合外键（同项目归属）用的锚点。名单不授予任何权限（见任务05）。
CREATE TABLE project_copywriters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, user_id),
  UNIQUE (project_id, id)
);

-- 文章登记表。fetch_revision 是取数修订：URL/登记变更时推进，同步写入靠它做旧响应守卫；
-- metrics_dirty 只表示「下次手动刷新有待处理项」，不代表存在自动任务。
CREATE TABLE project_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  keyword TEXT,
  notes TEXT,
  copywriter_id INTEGER REFERENCES project_copywriters(id) ON DELETE SET NULL,
  published_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  sort_order INTEGER,
  fetch_revision INTEGER NOT NULL DEFAULT 1,
  metrics_dirty INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, url),
  UNIQUE (id, project_id),
  FOREIGN KEY (project_id, copywriter_id) REFERENCES project_copywriters (project_id, id)
);
CREATE INDEX idx_project_articles_list ON project_articles (project_id, status, sort_order, id);
CREATE INDEX idx_project_articles_copywriter ON project_articles (project_id, copywriter_id);

-- 曾用地址历史：url 改了之后旧地址仍可查（历史月份数据不删）。UNIQUE(article_id, url)
-- 保证同一地址在同一篇文章下只记一次；复合外键保证历史行与文章同项目。
CREATE TABLE project_article_url_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  url_changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (article_id, url),
  FOREIGN KEY (article_id, project_id) REFERENCES project_articles (id, project_id) ON DELETE CASCADE
);
CREATE INDEX idx_article_url_history_lookup ON project_article_url_history (project_id, url);

-- 月度指标：一个月一行。值可空——NULL 是「未知」（没抓过/抓失败），与 0（抓到了零）
-- 是两件事，禁止 COALESCE 成 0 后判达标。各来源状态独立：
--   pending      还没取到数（含取数失败的未知）
--   complete     该次区间完整成功
--   unavailable  来源范围不支持（含未配置）
--   error        请求出错（原因在 *_error）
-- *_finalized 表示这个自然月已过数据延迟窗口、可以当定稿值跳过重抓。
-- mismatch 记 GSC 精确 URL 计数与响应变体的偏差诊断（任务07细化）。
CREATE TABLE project_article_monthly_metrics (
  article_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  month_start TEXT NOT NULL,
  month_end TEXT NOT NULL,
  gsc_clicks INTEGER,
  gsc_impressions INTEGER,
  gsc_ctr REAL,
  gsc_position REAL,
  ga4_pageviews INTEGER,
  ga4_key_events INTEGER,
  gsc_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (gsc_status IN ('pending', 'complete', 'unavailable', 'error')),
  gsc_error TEXT,
  gsc_cover_start TEXT,
  gsc_cover_end TEXT,
  gsc_fetched_at TEXT,
  gsc_finalized INTEGER NOT NULL DEFAULT 0,
  gsc_config_fingerprint TEXT,
  ga4_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (ga4_status IN ('pending', 'complete', 'unavailable', 'error')),
  ga4_error TEXT,
  ga4_cover_start TEXT,
  ga4_cover_end TEXT,
  ga4_fetched_at TEXT,
  ga4_finalized INTEGER NOT NULL DEFAULT 0,
  ga4_config_fingerprint TEXT,
  fetch_revision INTEGER NOT NULL,
  mismatch TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (article_id, month),
  FOREIGN KEY (article_id) REFERENCES project_articles(id) ON DELETE CASCADE
);
CREATE INDEX idx_monthly_metrics_month ON project_article_monthly_metrics (month, article_id);

-- 迁移基线：一篇旧文章一份，来自 ga4_metrics 的旧累计原样复制。
-- 基线不与新月度累计相加，页面/导出单列「迁移前累计/截至日」；水位列用于判断
-- 默认 0 究竟是真零还是从没抓过。
CREATE TABLE project_article_legacy_metrics (
  article_id INTEGER PRIMARY KEY,
  ga4_sessions INTEGER,
  ga4_users INTEGER,
  ga4_pageviews INTEGER,
  ga4_key_events INTEGER,
  settled_through TEXT,
  key_events_through TEXT,
  legacy_fetched_at TEXT,
  migrated_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ga4_metrics',
  FOREIGN KEY (article_id) REFERENCES project_articles(id) ON DELETE CASCADE
);

-- 项目级同步状态：run_id + lease_until 是同步请求的认领（数据库条件认领，两个后端通用，
-- 到期由下一次用户请求恢复，不写定时消费）；config/registry 修订用于旧响应写入守卫。
CREATE TABLE project_monitor_sync_state (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT,
  lease_until TEXT,
  config_revision INTEGER NOT NULL DEFAULT 1,
  registry_revision INTEGER NOT NULL DEFAULT 1,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============ 存量迁移 ============

-- 文章：保留 urls 原 id（禁止按新自增顺序猜旧指标关联）；published_date → published_at；
-- 全部默认 active + dirty（月度回填由任务07的刷新驱动，先标记待处理）。
-- project_id 悬空的行会被外键直接拦下（两个后端都开外键），不会静默丢弃。
INSERT INTO project_articles
  (id, project_id, url, title, keyword, notes, published_at, status, sort_order,
   fetch_revision, metrics_dirty, created_at, updated_at)
SELECT
  u.id, u.project_id, u.url, u.title, u.keyword, u.notes, u.published_date,
  'active', u.sort_order, 1, 1,
  COALESCE(u.created_at, datetime('now')),
  COALESCE(u.updated_at, u.created_at, datetime('now'))
FROM urls u;

-- 曾用地址历史：迁移时不造历史——当前 url 就是文章自己的地址，历史只从第一次改址开始记。

-- 月度指标：只搬「月初开始且结束仍在同月」的自然月候选；每文章/月选结束日最大
-- （并列再按抓取时间、id 稳定去重），不 SUM 重叠区间。全 NULL 的候选无法证明抓取
-- 成功，保留成 pending 行（值 NULL = 未知，不假装 0）。自定义/跨月窗口留档不进这里。
INSERT INTO project_article_monthly_metrics (
  article_id, month, month_start, month_end,
  gsc_clicks, gsc_impressions, gsc_ctr, gsc_position,
  ga4_pageviews, ga4_key_events,
  gsc_status, gsc_cover_start, gsc_cover_end, gsc_fetched_at, gsc_finalized,
  ga4_status, fetch_revision, updated_at
)
SELECT
  m.url_id,
  strftime('%Y-%m', m.start_date),
  strftime('%Y-%m-01', m.start_date),
  date(strftime('%Y-%m-01', m.start_date), 'start of month', '+1 month', '-1 day'),
  m.gsc_clicks, m.gsc_impressions, m.gsc_ctr, m.gsc_position,
  NULL, NULL,
  CASE
    WHEN m.gsc_clicks IS NULL AND m.gsc_impressions IS NULL
     AND m.gsc_ctr IS NULL AND m.gsc_position IS NULL
    THEN 'pending'
    ELSE 'complete'
  END,
  m.start_date, m.end_date, m.fetched_at, 0,
  'pending', 1, datetime('now')
FROM url_metrics m
WHERE m.start_date = strftime('%Y-%m-01', m.start_date)
  AND strftime('%Y-%m', m.start_date) = strftime('%Y-%m', m.end_date)
  AND m.id = (
    SELECT m2.id FROM url_metrics m2
    WHERE m2.url_id = m.url_id
      AND m2.start_date = strftime('%Y-%m-01', m2.start_date)
      AND strftime('%Y-%m', m2.start_date) = strftime('%Y-%m', m2.end_date)
      AND strftime('%Y-%m', m2.start_date) = strftime('%Y-%m', m.start_date)
    ORDER BY m2.end_date DESC, m2.fetched_at DESC, m2.id DESC
    LIMIT 1
  );

-- GA4 旧累计 → 迁移基线：原样复制（含默认 0），水位/原抓取时间一起带过来，
-- 供判断「默认 0 是否真抓过」；不与新月度累计相加。
INSERT INTO project_article_legacy_metrics
  (article_id, ga4_sessions, ga4_users, ga4_pageviews, ga4_key_events,
   settled_through, key_events_through, legacy_fetched_at, migrated_at, source)
SELECT
  g.url_id, g.sessions, g.users, g.pageviews, g.key_events,
  g.settled_through, g.key_events_through, g.last_fetched_at,
  datetime('now'), 'ga4_metrics'
FROM ga4_metrics g;

-- 同步状态：每个现存项目一行初始状态（修订号从 1 起，认领/释放由任务07写入）。
INSERT INTO project_monitor_sync_state (project_id, run_id, lease_until, config_revision, registry_revision, updated_at)
SELECT id, NULL, NULL, 1, 1, datetime('now') FROM projects;
