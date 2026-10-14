-- 旧记录的开始时间无法追溯，保留 NULL；终态更新时间可作为结束时间。
ALTER TABLE article_monitor_sync_jobs ADD COLUMN started_at TEXT;
ALTER TABLE article_monitor_sync_jobs ADD COLUMN finished_at TEXT;
UPDATE article_monitor_sync_jobs SET finished_at=updated_at WHERE status IN ('succeeded','partial','failed');
CREATE INDEX article_jobs_history ON article_monitor_sync_jobs(created_at DESC,job_id DESC);
CREATE INDEX ai_runs_history ON ai_insight_runs(created_at DESC,id DESC);
CREATE INDEX resource_jobs_history ON google_resource_sync_jobs(created_at DESC,id DESC);
