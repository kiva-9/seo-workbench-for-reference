-- 发布日期决定取数窗口；所有写入口统一失效旧计划，防止迟到响应覆盖新窗口。
CREATE TRIGGER article_publication_fetch_guard
AFTER UPDATE OF published_at ON project_articles
WHEN NEW.published_at IS NOT OLD.published_at
BEGIN
  UPDATE project_articles
  SET fetch_revision = fetch_revision + 1, metrics_dirty = 1
  WHERE id = NEW.id;
END;
