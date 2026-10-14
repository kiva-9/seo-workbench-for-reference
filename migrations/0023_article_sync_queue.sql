-- 完整同步意图和剩余范围独立于进程保存；租约令牌阻止旧执行者迟到写入。
ALTER TABLE article_monitor_sync_jobs ADD COLUMN queue_json TEXT;
ALTER TABLE article_monitor_sync_jobs ADD COLUMN lease_id TEXT;
ALTER TABLE article_monitor_sync_jobs ADD COLUMN lease_until TEXT;
ALTER TABLE article_monitor_sync_jobs ADD COLUMN next_attempt_at TEXT;
CREATE INDEX article_sync_queue_due ON article_monitor_sync_jobs(status, next_attempt_at, lease_until)
  WHERE queue_json IS NOT NULL AND status IN ('queued', 'running');
