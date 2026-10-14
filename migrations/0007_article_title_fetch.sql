-- 0007_article_title_fetch.sql —— 文章标题自动获取（站内 + 站外，对齐源项目 0037/0047 轻量版）
--
-- 标题只是展示件：不进指标计算、不标 dirty、不触发同步。语义：
--   - title_source='manual'：人工维护的标题，自动抓取永不覆盖；
--   - title_source='fetched'：抓来的标题；
--   - title_fetch_status：pending（等抓）/ ok / failed（尝试耗尽，终态）；
--   - title_fetch_attempts：累计尝试次数（一次成功即终态，不再抓）；
--   - 同一 URL 全局只抓一次：article_title_fetches 是 URL 级缓存 + 租约。
-- 本仓库同步是「用户按钮触发、单请求内完成」，不引入队列/cron：项目级「获取缺失标题」
-- 在一次请求内串行处理（每轮 ≤30 个 URL，同域名串行是礼貌下限），进度由响应一次性回报；
-- 单篇「获取标题」立即抓立即写。

-- 站内文章：标题来源与抓取状态
ALTER TABLE project_articles ADD COLUMN title_source TEXT;
ALTER TABLE project_articles ADD COLUMN title_fetch_status TEXT;
ALTER TABLE project_articles ADD COLUMN title_fetch_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_articles ADD COLUMN title_fetch_error TEXT;
ALTER TABLE project_articles ADD COLUMN title_fetched_at TEXT;

-- 站外文章：同一套状态（抓取逻辑与缓存共用）
ALTER TABLE project_external_articles ADD COLUMN title_source TEXT;
ALTER TABLE project_external_articles ADD COLUMN title_fetch_status TEXT;
ALTER TABLE project_external_articles ADD COLUMN title_fetch_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_external_articles ADD COLUMN title_fetch_error TEXT;
ALTER TABLE project_external_articles ADD COLUMN title_fetched_at TEXT;

-- URL 级缓存 + 租约：同一地址（可能登记在多个项目/两类文章下）只抓一次。
-- claim_token/claimed_at 是数据库租约：并发的 UI 点击不会重复出网；1 分钟未完成自动放过。
CREATE TABLE article_title_fetches (
  url TEXT PRIMARY KEY,
  title TEXT,
  claim_token TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_article_title_fetches_claim
  ON article_title_fetches(claim_token, claimed_at);
