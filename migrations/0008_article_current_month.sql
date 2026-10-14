-- 0008_article_current_month.sql —— 本月临时数据（对齐源项目 0040，读时合并版）
--
-- 语义（源项目 docs/article-title-fetch.md 同源的「本月临时」契约，见其监控侧说明）：
--   - 从本月 1 号（或发布日）取到各数据源实际最新的日期：GSC 用 dataState=all 的新鲜数据，
--     GA4 取到属性时区的昨天。两个来源各自的截止日记在 gsc_end_date / ga4_end_date。
--   - 每篇文章一行、每轮整行覆盖；不写 project_article_monthly_metrics——
--     完整自然月仍走月度表（月末+延迟后定稿），列表累计/达标/明细/导出在读取时
--     把本月临时行接到月度快照后面（src/lib/current-month.js）。
--   - 本仓库没有 cron：本月临时数据在用户点「同步数据」时刷新（单篇刷新同理），
--     响应里回报各源截止日；没有自动轮转。
--   - 停用/删除的文章清掉旧行，避免重新启用时露出过期的本月数。
--
-- 存量回填：升级前当前月写在月度表里的未定稿行（finalized=0）原样保留——读取时
-- 按「有临时行就用临时行，否则用月度行」合并，不会重复计数；下次同步后临时行接管。

CREATE TABLE project_article_current_metrics (
  article_id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  range_start TEXT NOT NULL,
  gsc_end_date TEXT,
  ga4_end_date TEXT,
  gsc_clicks REAL,
  ga4_views REAL,
  ga4_key_events REAL,
  gsc_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (gsc_state IN ('pending', 'complete', 'empty', 'unavailable', 'error')),
  ga4_views_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (ga4_views_state IN ('pending', 'complete', 'empty', 'unavailable', 'error')),
  ga4_key_events_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (ga4_key_events_state IN ('pending', 'complete', 'empty', 'unconfigured', 'unavailable', 'error')),
  errors_json TEXT NOT NULL DEFAULT '[]',
  synced_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (article_id) REFERENCES project_articles(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_project_article_current_metrics_project
  ON project_article_current_metrics(project_id, article_id);

CREATE TABLE project_article_current_sync_state (
  project_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'running', 'succeeded', 'partial', 'failed')),
  month TEXT,
  gsc_end_date TEXT,
  ga4_end_date TEXT,
  external_requests INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 存量回填：把升级前「当前月的未定稿月度行」搬进临时表（只搬未定稿的；已定稿的
-- 当前月行是完整月数据，继续留在月度表里参与统计）。
INSERT OR IGNORE INTO project_article_current_metrics (
  article_id, project_id, month, range_start, gsc_end_date, ga4_end_date,
  gsc_clicks, ga4_views, ga4_key_events,
  gsc_state, ga4_views_state, ga4_key_events_state, errors_json, synced_at, updated_at
)
SELECT m.article_id, a.project_id, m.month, m.month_start, m.gsc_cover_end, m.ga4_cover_end,
  m.gsc_clicks, m.ga4_pageviews, m.ga4_key_events,
  CASE m.gsc_status WHEN 'complete' THEN 'complete' WHEN 'error' THEN 'error' WHEN 'unavailable' THEN 'unavailable' ELSE 'pending' END,
  CASE m.ga4_status WHEN 'complete' THEN 'complete' WHEN 'error' THEN 'error' WHEN 'unavailable' THEN 'unavailable' ELSE 'pending' END,
  CASE m.ga4_status WHEN 'complete' THEN 'complete' WHEN 'error' THEN 'error' WHEN 'unavailable' THEN 'unavailable' ELSE 'pending' END,
  '[]', m.gsc_fetched_at, m.updated_at
FROM project_article_monthly_metrics m
JOIN project_articles a ON a.id = m.article_id
WHERE m.month = strftime('%Y-%m', 'now')
  AND (m.gsc_finalized = 0 OR m.ga4_finalized = 0);
