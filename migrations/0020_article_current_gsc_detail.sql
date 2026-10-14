-- 临时 GSC 指标与点击使用同一响应和窗口；失败时保留成功的配套明细。
ALTER TABLE project_article_current_metrics ADD COLUMN gsc_impressions REAL;
ALTER TABLE project_article_current_metrics ADD COLUMN gsc_ctr REAL;
ALTER TABLE project_article_current_metrics ADD COLUMN gsc_position REAL;
ALTER TABLE project_article_current_metrics ADD COLUMN gsc_success_details TEXT;
