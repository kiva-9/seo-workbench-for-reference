-- 0009_article_metric_success_facts.sql —— 指标「最后成功事实」列（对齐源项目 0042）
--
-- 契约：每个 (文章, 月份, 来源) 的「最后成功事实」（值 + 口径快照 + 时间）与「最近一次
-- 尝试」（state/值/errors）分离存放。失败尝试只写尝试层，不再有销毁成功事实的单一路径——
-- 失败月不再从累计里消失，状态列仍按尝试层并列表达「旧成功值 + 本次失败」。
--
-- 来源前缀：gsc（GSC 点击）、ga4_views（GA4 浏览）、ga4_key_events（GA4 关键事件），
-- 彼此独立。真实 0 是合法事实值；complete + NULL 不是事实；error/unavailable/pending 不造事实。
--
-- 口径快照：本仓库不做 v1 身份（URL 集合/资源/筛选）的完整镜像，用 {"kind":"v1"} 标记
-- 「同项目同配置的一次成功」；口径变更（换事件集合/换资源）由 metrics_dirty + 指纹失效
-- 机制处理，重抓成功后事实自然更新。config 里的 kind 只用于读侧区分「有没有事实」。

ALTER TABLE project_article_monthly_metrics ADD COLUMN gsc_success_value REAL;
ALTER TABLE project_article_monthly_metrics ADD COLUMN gsc_success_config TEXT;
ALTER TABLE project_article_monthly_metrics ADD COLUMN gsc_success_at TEXT;
ALTER TABLE project_article_monthly_metrics ADD COLUMN ga4_views_success_value REAL;
ALTER TABLE project_article_monthly_metrics ADD COLUMN ga4_views_success_config TEXT;
ALTER TABLE project_article_monthly_metrics ADD COLUMN ga4_views_success_at TEXT;
ALTER TABLE project_article_monthly_metrics ADD COLUMN ga4_key_events_success_value REAL;
ALTER TABLE project_article_monthly_metrics ADD COLUMN ga4_key_events_success_config TEXT;
ALTER TABLE project_article_monthly_metrics ADD COLUMN ga4_key_events_success_at TEXT;

-- 回填：state=complete 且值非 NULL 的来源生成事实（存量无法追溯当时口径，固定 legacy）
-- 本仓库的月度表用 gsc_status/ga4_status（一列管两个 GA4 指标）
UPDATE project_article_monthly_metrics
SET gsc_success_value = gsc_clicks, gsc_success_config = '{"kind":"legacy"}', gsc_success_at = gsc_fetched_at
WHERE gsc_status = 'complete' AND gsc_clicks IS NOT NULL;
UPDATE project_article_monthly_metrics
SET ga4_views_success_value = ga4_pageviews, ga4_views_success_config = '{"kind":"legacy"}', ga4_views_success_at = ga4_fetched_at
WHERE ga4_status = 'complete' AND ga4_pageviews IS NOT NULL;
UPDATE project_article_monthly_metrics
SET ga4_key_events_success_value = ga4_key_events, ga4_key_events_success_config = '{"kind":"legacy"}', ga4_key_events_success_at = ga4_fetched_at
WHERE ga4_status = 'complete' AND ga4_key_events IS NOT NULL;
