-- 0001_baseline.sql —— 基线结构：全新数据库一次建到当前形态
--
-- 这是旧 001-baseline.js（补列 + 数据订正 + 清理遗留表的补丁式迁移）在全新库上的最终结果，
-- 直建成终态：老库的回填/清理语句对新库都是空操作，不再保留。
-- 旧库里结构版本号记在 PRAGMA user_version，本地 migrate.js 首次以 _migrations 表记账时
-- 会按它把已发布迁移标记为已应用，所以本文件不会被重放到老库上。
-- wrangler d1 migrations 也认这份文件（编号 0001 起，下划线命名）。
--
-- 已发布，不要再改；结构变化加新的 NNNN_name.sql。

CREATE TABLE google_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  refresh_token TEXT,
  connected_at TEXT,
  note TEXT,
  owner_user_id INTEGER
);

-- 用户：团队模式下身份来自 Cloudflare Access 验证过的邮箱（见 src/middleware/cf-access.js），
-- 单用户模式下只有一个固定的本机用户。这里只存"这个邮箱是谁、什么角色"，不存密码——应用不做登录页。
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  role TEXT DEFAULT 'member',
  created_at TEXT,
  last_seen_at TEXT
);

-- 项目默认只有 owner 一个人能看（硬隔离），管理员可以给项目加协作者共享给别人，
-- 加了就是完整权限（跟 owner 一样），不做只读/可编辑细分。
CREATE TABLE project_collaborators (
  project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  added_at TEXT,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  client_name TEXT,
  industry TEXT,
  website TEXT,
  contract_start TEXT,
  contract_end TEXT,
  monthly_fee REAL,
  status TEXT DEFAULT 'active',
  account_id INTEGER,
  gsc_site TEXT,
  ga4_property_id TEXT,
  notes TEXT,
  created_at TEXT,
  gsc_account_id INTEGER,
  ga4_account_id INTEGER,
  key_event_names TEXT,
  owner_user_id INTEGER
);

-- 任务状态只有「待办(todo) / 已完成(done)」两种，已逾期由「到期日 < 今天且未完成」派生
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'todo',
  priority TEXT DEFAULT 'medium',
  due_date TEXT,
  created_at TEXT,
  owner_user_id INTEGER
);

CREATE TABLE links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  tags TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT,
  owner_user_id INTEGER
);

-- URL 排序：项目里手动拖拽调整顺序，sort_order 持久化到库，切走再切回来顺序不变
-- 文章属性（title/keyword/published_date/notes）全部可空，没填时界面回落显示 URL
CREATE TABLE urls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,
  url TEXT NOT NULL,
  sort_order INTEGER,
  created_at TEXT,
  title TEXT,
  keyword TEXT,
  published_date TEXT,
  notes TEXT,
  updated_at TEXT,
  UNIQUE(project_id, url)
);

CREATE TABLE url_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url_id INTEGER,
  project_id INTEGER,
  period_days INTEGER,
  start_date TEXT,
  end_date TEXT,
  gsc_clicks INTEGER,
  gsc_impressions INTEGER,
  gsc_ctr REAL,
  gsc_position REAL,
  ga_sessions INTEGER,
  ga_users INTEGER,
  ga_pageviews INTEGER,
  fetched_at TEXT,
  ga_key_events INTEGER
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- 站内 URL 的 GA4【累计】指标：每条 URL 一行，本地增量累计。
-- 与 url_metrics（按月窗口，只放 GSC）分开存储，因为 GA4 是累计、GSC 按月，窗口不同。
CREATE TABLE ga4_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url_id INTEGER NOT NULL,
  project_id INTEGER,
  sessions INTEGER DEFAULT 0,
  users INTEGER DEFAULT 0,
  pageviews INTEGER DEFAULT 0,
  key_events INTEGER DEFAULT 0,
  settled_through TEXT,
  key_events_through TEXT,
  last_fetched_at TEXT
);

-- 我发的外链：用户主动登记的 SEO 外链建设记录 + GA4 反查回来的累计效果。
-- 登记字段（url/anchor_text/published_at/notes）由用户维护，
-- 累计字段（sessions/users/key_events/*_through）由 fetchProjectExternalLinks 回写。
-- settled_through / key_events_through 是「已累计到的最后一天」，每次抓取只加新增段；
-- 关键事件名变化时通过 resetKeyEventsAccumulation 重置。
CREATE TABLE external_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  anchor_text TEXT,
  published_at TEXT,
  notes TEXT,
  created_at TEXT,
  sessions INTEGER DEFAULT 0,
  users INTEGER DEFAULT 0,
  key_events INTEGER DEFAULT 0,
  settled_through TEXT,
  key_events_through TEXT,
  last_fetched_at TEXT
);

-- GSC 全量快照：每次抓取一个大窗口（16 个月）的 page+query 数据，滚动保留最近 3 个。
-- 快照内分两层：URL 级汇总（gsc_snapshot_urls）+ URL-query 明细（gsc_snapshot_queries）。
CREATE TABLE gsc_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  snapshot_date TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at TEXT
);
CREATE TABLE gsc_snapshot_urls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL,
  url_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  clicks INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  ctr REAL DEFAULT 0,
  position REAL DEFAULT 0
);
CREATE TABLE gsc_snapshot_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL,
  url_id INTEGER NOT NULL,
  query TEXT NOT NULL,
  clicks INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  ctr REAL DEFAULT 0,
  position REAL DEFAULT 0
);

-- 指标按「窗口」唯一，支撑 UPSERT（抓取覆盖而不是追加）
CREATE UNIQUE INDEX ux_url_metrics_window ON url_metrics(url_id, start_date, end_date);
CREATE INDEX ix_url_metrics_lookup ON url_metrics(project_id, start_date, end_date, url_id);
CREATE INDEX ix_url_metrics_period ON url_metrics(project_id, period_days, end_date DESC);

CREATE INDEX ix_tasks_project ON tasks(project_id);
CREATE INDEX ix_urls_project ON urls(project_id);

-- 团队模式的数据隔离：projects/tasks/links/google_accounts 各自记一个 owner。
-- urls/url_metrics/ga4_metrics/external_links/gsc_snapshots* 不需要各自加列——
-- 它们的 project_id 是 NOT NULL，权限跟着所属 project 的 owner 走就够了。
CREATE INDEX ix_projects_owner ON projects(owner_user_id);
CREATE INDEX ix_tasks_owner ON tasks(owner_user_id);
CREATE INDEX ix_links_owner ON links(owner_user_id);
CREATE INDEX ix_google_accounts_owner ON google_accounts(owner_user_id);
CREATE INDEX ix_project_collaborators_user ON project_collaborators(user_id);

CREATE INDEX ix_links_project ON links(project_id, created_at DESC);
CREATE INDEX ix_links_title ON links(title);

-- 累计表索引：站内 GA4 每条 URL 一行；外链按项目查询
CREATE UNIQUE INDEX ux_ga4_url ON ga4_metrics(url_id);
CREATE INDEX ix_ga4_project ON ga4_metrics(project_id);
CREATE INDEX ix_external_links_project ON external_links(project_id, created_at DESC);

-- GSC 全量快照索引
CREATE INDEX ix_gsc_snapshots_project ON gsc_snapshots(project_id, created_at DESC);
CREATE UNIQUE INDEX ux_gsc_snapshot_urls ON gsc_snapshot_urls(snapshot_id, url_id);
CREATE INDEX ix_gsc_snapshot_urls_snap ON gsc_snapshot_urls(snapshot_id, impressions DESC);
CREATE UNIQUE INDEX ux_gsc_snapshot_queries ON gsc_snapshot_queries(snapshot_id, url_id, query);
CREATE INDEX ix_gsc_snapshot_queries_url ON gsc_snapshot_queries(snapshot_id, url_id, impressions DESC);

-- 注意：这里刻意没有任何「按保留期清理」的逻辑，以后的迁移也不要加。
-- url_metrics（GSC 按月账本）和 ga4_metrics（GA4 累计）都是本地长期账本——
-- Google 自己只保留 16 个月，删了要不回来，而体量根本不成问题。
-- gsc_snapshot_* 靠「滚动保留最近 3 个快照」自限，也不需要按时间清。
