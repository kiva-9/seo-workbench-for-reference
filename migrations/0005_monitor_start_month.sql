-- 0005_monitor_start_month.sql —— 项目监控起点（任务07）
--
-- 监控起点（YYYY-MM）：首次回填由用户显式选择并持久化，作为覆盖完整性与达标判断依据；
-- 不设时不允许静默按 2020 逐月回填。后续普通刷新沿用该起点推进到当前安全月。

ALTER TABLE project_monitor_sync_state ADD COLUMN monitor_start_month TEXT;
