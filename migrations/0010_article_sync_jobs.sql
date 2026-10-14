-- 0010_article_sync_jobs.sql —— 文章同步任务表（对齐源项目 0022 的 article_monitor_sync_jobs 轻量版）
--
-- 本仓库同步仍是「一次请求内完成」，但大项目（上千篇 × 多月 × 双源）会让请求挂很久、
-- 没有进度反馈。任务是进程内的：入队即返回 202，前端轮询任务状态到终态。
-- 部分唯一索引保证「每项目同时只有一个活动任务」——重复点击返回正在进行的任务。
-- 服务重启会让进程内任务消失：updated_at 超过租约期的活动任务按失败处理
-- （读取时判定），下次点击重新排队。

CREATE TABLE article_monitor_sync_jobs (
  job_id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed')),
  scope TEXT NOT NULL DEFAULT 'project',      -- project | article
  article_id INTEGER,                          -- scope='article' 时的目标
  force INTEGER NOT NULL DEFAULT 0,
  months_json TEXT NOT NULL DEFAULT '[]',
  progress_step TEXT,
  errors_json TEXT NOT NULL DEFAULT '[]',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 每项目同时最多一个活动任务（queued/running）
CREATE UNIQUE INDEX idx_article_monitor_jobs_active
  ON article_monitor_sync_jobs(project_id) WHERE status IN ('queued', 'running');
